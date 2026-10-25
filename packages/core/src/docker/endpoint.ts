// Locate the Docker Engine API the same way the docker CLI does:
// settings override → DOCKER_HOST → current docker context → well-known sockets for this OS.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/**
 * Paths are built for the platform being described (`e.platform`), not the host running this code, so the
 * logic is the same everywhere (and tests that simulate macOS / Linux / Windows pass on any CI runner).
 */
export function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join
}

export interface DockerEndpoint {
  /** Normalized URI: unix:///path, npipe:////./pipe/name, tcp://host:port */
  uri: string
  source: 'settings' | 'DOCKER_HOST' | 'context' | 'default' | 'none'
  contextName?: string
  tls?: { ca?: string; cert?: string; key?: string; verify: boolean }
}

export interface EndpointEnv {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  exists: (p: string) => boolean
  read: (p: string) => string
}

const defaultEnv = (): EndpointEnv => ({
  env: process.env,
  platform: process.platform,
  home: homedir(),
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8')
})

export function dockerConfigDir(e: EndpointEnv): string {
  const join = joinFor(e.platform)
  return e.env.DOCKER_CONFIG || join(e.home, '.docker')
}

function tlsFromDir(dir: string, verify: boolean, e: EndpointEnv): DockerEndpoint['tls'] {
  const join = joinFor(e.platform)
  const file = (n: string) => (e.exists(join(dir, n)) ? e.read(join(dir, n)) : undefined)
  return { ca: file('ca.pem'), cert: file('cert.pem'), key: file('key.pem'), verify }
}

export function currentContextName(e: EndpointEnv): string | undefined {
  const join = joinFor(e.platform)
  if (e.env.DOCKER_CONTEXT) return e.env.DOCKER_CONTEXT
  try {
    const cfg = JSON.parse(e.read(join(dockerConfigDir(e), 'config.json'))) as { currentContext?: string }
    return cfg.currentContext
  } catch {
    return undefined
  }
}

function fromContext(e: EndpointEnv): DockerEndpoint | undefined {
  const join = joinFor(e.platform)
  const name = currentContextName(e)
  if (!name || name === 'default') return undefined
  const hash = createHash('sha256').update(name).digest('hex')
  try {
    const meta = JSON.parse(e.read(join(dockerConfigDir(e), 'contexts', 'meta', hash, 'meta.json'))) as {
      Endpoints?: { docker?: { Host?: string; SkipTLSVerify?: boolean } }
    }
    const host = meta.Endpoints?.docker?.Host
    if (!host) return undefined
    const tlsDir = join(dockerConfigDir(e), 'contexts', 'tls', hash, 'docker')
    return {
      uri: host,
      source: 'context',
      contextName: name,
      tls:
        host.startsWith('tcp://') && e.exists(tlsDir)
          ? tlsFromDir(tlsDir, !meta.Endpoints?.docker?.SkipTLSVerify, e)
          : undefined
    }
  } catch {
    return undefined
  }
}

export function defaultSocketCandidates(e: EndpointEnv): string[] {
  const h = e.home
  if (e.platform === 'win32') {
    return [
      'npipe:////./pipe/docker_engine',
      'npipe:////./pipe/dockerDesktopLinuxEngine',
      'npipe:////./pipe/podman-machine-default'
    ]
  }
  if (e.platform === 'darwin') {
    return [
      `unix://${h}/.docker/run/docker.sock`, // Docker Desktop
      'unix:///var/run/docker.sock',
      `unix://${h}/.orbstack/run/docker.sock`,
      `unix://${h}/.colima/default/docker.sock`,
      `unix://${h}/.colima/docker.sock`,
      `unix://${h}/.rd/docker.sock` // Rancher Desktop
    ]
  }
  const runtime = e.env.XDG_RUNTIME_DIR
  return [
    'unix:///var/run/docker.sock',
    ...(runtime ? [`unix://${runtime}/docker.sock`] : []), // rootless
    `unix://${h}/.docker/desktop/docker.sock` // Docker Desktop for Linux
  ]
}

function socketPath(uri: string): string | undefined {
  if (uri.startsWith('unix://')) return uri.slice('unix://'.length)
  if (uri.startsWith('npipe://')) return uri.slice('npipe://'.length).replace(/\//g, '\\')
  return undefined
}

export function resolveEndpoint(override: string, e: EndpointEnv = defaultEnv()): DockerEndpoint {
  if (override.trim()) return { uri: override.trim(), source: 'settings' }
  if (e.env.DOCKER_HOST) {
    const verify = !!e.env.DOCKER_TLS_VERIFY && e.env.DOCKER_TLS_VERIFY !== '0'
    const certDir = e.env.DOCKER_CERT_PATH
    return {
      uri: e.env.DOCKER_HOST,
      source: 'DOCKER_HOST',
      tls: certDir && e.env.DOCKER_HOST.startsWith('tcp://') ? tlsFromDir(certDir, verify, e) : undefined
    }
  }
  const ctx = fromContext(e)
  if (ctx) return ctx
  const candidates = defaultSocketCandidates(e)
  // Named pipes cannot be stat()ed reliably, so on Windows try the first and let the ping decide.
  const found = e.platform === 'win32' ? candidates[0] : candidates.find((c) => e.exists(socketPath(c) ?? ''))
  return found ? { uri: found, source: 'default' } : { uri: candidates[0], source: 'none' }
}

export function endpointSocketPath(uri: string): string | undefined {
  return socketPath(uri)
}
