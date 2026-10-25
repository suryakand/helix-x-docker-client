// Read the credentials the docker CLI already has (`docker login`) so users can import them instead of
// re-typing: inline `auths` in ~/.docker/config.json, the default `credsStore` and per-registry
// `credHelpers` (docker-credential-osxkeychain / -desktop / -wincred / -pass / -secretservice …).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { DockerLoginCandidate, RegistryCredentials, RegistryType } from '@helix/shared/types'

export interface DockerLogin {
  server: string
  username: string
  secret: string
  source: string
}

export interface DockerLoginsEnv {
  configPath: string
  read: (path: string) => string
  exists: (path: string) => boolean
  /** Run `docker-credential-<helper> <action>` with optional stdin; resolves stdout. */
  runHelper: (helper: string, action: 'list' | 'get', input?: string) => Promise<string>
}

/** Docker Desktop keeps its own OAuth tokens in the credential store; they are not registry logins. */
const INTERNAL_ENTRY = /\/(access|refresh)-token$|^https:\/\/index\.docker\.io\/v1\/\w+-token/

export function defaultDockerLoginsEnv(): DockerLoginsEnv {
  const configDir = process.env.DOCKER_CONFIG || join(homedir(), '.docker')
  return {
    configPath: join(configDir, 'config.json'),
    read: (p) => readFileSync(p, 'utf8'),
    exists: existsSync,
    runHelper: runCredentialHelper
  }
}

/** Apps started from Finder / Start menu get a minimal PATH; add the usual helper locations. */
function helperPath(): string {
  const extra =
    process.platform === 'win32'
      ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin')]
      : process.platform === 'darwin'
        ? [
            '/usr/local/bin',
            '/opt/homebrew/bin',
            join(homedir(), '.docker', 'bin'),
            '/Applications/Docker.app/Contents/Resources/bin'
          ]
        : ['/usr/local/bin', '/usr/bin', join(homedir(), '.docker', 'bin')]
  return [process.env.PATH ?? '', ...extra].filter(Boolean).join(delimiter)
}

function runCredentialHelper(helper: string, action: 'list' | 'get', input?: string): Promise<string> {
  if (!/^[\w.-]+$/.test(helper)) return Promise.reject(new Error(`Invalid credential helper name: ${helper}`))
  return new Promise((resolve, reject) => {
    const child = spawn(`docker-credential-${helper}`, [action], {
      env: { ...process.env, PATH: helperPath() },
      windowsHide: true,
      timeout: 20_000
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(
        new Error(
          e.code === 'ENOENT' ? `docker-credential-${helper} is not installed or not on PATH` : e.message
        )
      )
    )
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error((err || out).trim() || `docker-credential-${helper} exited with ${code}`))
    )
    child.stdin.end(input ?? '')
  })
}

interface DockerConfigFile {
  auths?: Record<string, { auth?: string; username?: string; password?: string; identitytoken?: string }>
  credsStore?: string
  credHelpers?: Record<string, string>
}

/** All logins docker knows about. Problems with individual helpers are reported, not thrown. */
export async function readDockerLogins(
  e: DockerLoginsEnv
): Promise<{ logins: DockerLogin[]; warnings: string[] }> {
  const warnings: string[] = []
  if (!e.exists(e.configPath))
    return { logins: [], warnings: [`${e.configPath} does not exist (no docker login yet)`] }
  let cfg: DockerConfigFile
  try {
    cfg = JSON.parse(e.read(e.configPath)) as DockerConfigFile
  } catch (err) {
    return { logins: [], warnings: [`Cannot read ${e.configPath}: ${(err as Error).message}`] }
  }

  const found = new Map<string, DockerLogin>()
  const add = (l: DockerLogin) => {
    if (!INTERNAL_ENTRY.test(l.server) && (l.username || l.secret)) found.set(l.server, l)
  }

  // 1. Inline credentials.
  for (const [server, a] of Object.entries(cfg.auths ?? {})) {
    if (a.auth) {
      const decoded = Buffer.from(a.auth, 'base64').toString('utf8')
      const i = decoded.indexOf(':')
      add({ server, username: decoded.slice(0, i), secret: decoded.slice(i + 1), source: 'config.json' })
    } else if (a.username && a.password) {
      add({ server, username: a.username, secret: a.password, source: 'config.json' })
    } else if (a.identitytoken) {
      add({ server, username: '<token>', secret: a.identitytoken, source: 'config.json (identity token)' })
    }
  }

  const fromHelper = async (helper: string, server: string) => {
    try {
      const out = JSON.parse(await e.runHelper(helper, 'get', server)) as {
        Username?: string
        Secret?: string
      }
      if (out.Secret)
        add({ server, username: out.Username ?? '', secret: out.Secret, source: `helper: ${helper}` })
    } catch (err) {
      warnings.push(`${server} (${helper}): ${(err as Error).message}`)
    }
  }

  // 2. Per-registry helpers.
  for (const [server, helper] of Object.entries(cfg.credHelpers ?? {})) await fromHelper(helper, server)

  // 3. Default credential store: everything it lists that is not already covered.
  if (cfg.credsStore) {
    let servers: string[] = Object.keys(cfg.auths ?? {})
    try {
      servers = [
        ...new Set([
          ...servers,
          ...Object.keys(JSON.parse(await e.runHelper(cfg.credsStore, 'list')) as object)
        ])
      ]
    } catch (err) {
      warnings.push(`Cannot list credentials from ${cfg.credsStore}: ${(err as Error).message}`)
    }
    for (const server of servers) {
      if (found.has(server) || cfg.credHelpers?.[server] || INTERNAL_ENTRY.test(server)) continue
      await fromHelper(cfg.credsStore, server)
    }
  }
  return { logins: [...found.values()], warnings }
}

export function serverHost(server: string): string {
  return server
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

export interface MappedLogin {
  type: RegistryType
  url: string
  namespace?: string
  plainHttp: boolean
  credentials: RegistryCredentials
  supported: boolean
  note?: string
  name: string
}

/** Decide which provider a docker login belongs to and how its secret maps to that provider's fields. */
export function mapDockerLogin(l: DockerLogin): MappedLogin {
  const host = serverHost(l.server)
  const userPass = { username: l.username, password: l.secret }
  const base = { plainHttp: false, credentials: userPass, supported: true, name: host }
  if (['index.docker.io', 'registry-1.docker.io', 'docker.io'].includes(host)) {
    return {
      ...base,
      type: 'dockerhub',
      url: 'https://registry-1.docker.io',
      namespace: l.username || undefined,
      name: `Docker Hub (${l.username})`
    }
  }
  if (host === 'ghcr.io')
    return { ...base, type: 'ghcr', url: 'https://ghcr.io', name: `GitHub (${l.username})` }
  if (host.endsWith('.azurecr.io')) {
    return l.username === '<token>'
      ? {
          ...base,
          type: 'acr',
          url: `https://${host}`,
          credentials: { username: '00000000-0000-0000-0000-000000000000', password: l.secret }
        }
      : { ...base, type: 'acr', url: `https://${host}` }
  }
  if (/^\d{12}\.dkr\.ecr(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) {
    return {
      ...base,
      type: 'ecr',
      url: `https://${host}`,
      supported: false,
      note: 'docker stores a 12-hour ECR token. Add this registry with AWS access keys instead.'
    }
  }
  if (host === 'gcr.io' || host.endsWith('.gcr.io') || host.endsWith('-docker.pkg.dev')) {
    if (l.username === '_json_key')
      return { ...base, type: 'gcr', url: `https://${host}`, credentials: { serviceAccountJson: l.secret } }
    if (l.username === 'oauth2accesstoken') {
      return {
        ...base,
        type: 'gcr',
        url: `https://${host}`,
        credentials: { accessToken: l.secret },
        note: 'Access tokens expire after about an hour.'
      }
    }
  }
  if (host === 'registry.gitlab.com') {
    return {
      ...base,
      type: 'gitlab',
      url: 'https://registry.gitlab.com',
      note: 'Set the group or project path after importing to list repositories.'
    }
  }
  if (l.username === '<token>') {
    return {
      ...base,
      type: 'generic',
      url: `https://${host}`,
      supported: false,
      note: 'OAuth identity tokens are only supported for Azure Container Registry.'
    }
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
  return { ...base, type: 'generic', url: `${local ? 'http' : 'https'}://${host}`, plainHttp: local }
}

export function toCandidate(l: DockerLogin, alreadyAdded: boolean): DockerLoginCandidate {
  const m = mapDockerLogin(l)
  return {
    server: l.server,
    username: l.username === '<token>' ? '(identity token)' : l.username,
    source: l.source,
    type: m.type,
    url: m.url,
    supported: m.supported,
    alreadyAdded,
    note: m.note
  }
}
