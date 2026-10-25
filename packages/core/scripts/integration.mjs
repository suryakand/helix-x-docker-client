#!/usr/bin/env node
// Starts two throw-away registry:2 containers (anonymous + htpasswd basic auth), builds a tiny fixture
// image, runs the integration suite (vitest.integration.config.mts) and cleans everything up.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const tmp = join(root, 'tests', 'integration', '.tmp')
const ANON_PORT = process.env.HELIX_IT_ANON_PORT ?? '5101'
const AUTH_PORT = process.env.HELIX_IT_AUTH_PORT ?? '5102'
const USER = 'helix'
const PASS = 'helix-secret'
const names = ['helix-it-anon', 'helix-it-auth']

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts }).trim()

function htpasswd() {
  try {
    return sh('htpasswd', ['-Bbn', USER, PASS])
  } catch {
    return sh('docker', ['run', '--rm', '--entrypoint', 'htpasswd', 'httpd:2-alpine', '-Bbn', USER, PASS])
  }
}

function cleanup() {
  for (const n of names) spawnSync('docker', ['rm', '-f', n], { stdio: 'ignore' })
}

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url)
      if (res.status === 200 || res.status === 401) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Registry at ${url} did not start`)
}

cleanup()
rmSync(tmp, { recursive: true, force: true })
mkdirSync(join(tmp, 'auth'), { recursive: true })
writeFileSync(join(tmp, 'auth', 'htpasswd'), htpasswd() + '\n')

const common = ['-e', 'REGISTRY_STORAGE_DELETE_ENABLED=true']
sh('docker', ['run', '-d', '--name', names[0], '-p', `127.0.0.1:${ANON_PORT}:5000`, ...common, 'registry:2'])
sh('docker', [
  'run',
  '-d',
  '--name',
  names[1],
  '-p',
  `127.0.0.1:${AUTH_PORT}:5000`,
  ...common,
  '-v',
  `${join(tmp, 'auth')}:/auth:ro`,
  '-e',
  'REGISTRY_AUTH=htpasswd',
  '-e',
  'REGISTRY_AUTH_HTPASSWD_REALM=helix',
  '-e',
  'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd',
  'registry:2'
])

let code
try {
  await waitFor(`http://127.0.0.1:${ANON_PORT}/v2/`)
  await waitFor(`http://127.0.0.1:${AUTH_PORT}/v2/`)
  const fixtureTag = 'helix-it/fixture:1.0'
  sh('docker', ['build', '-q', '-t', fixtureTag, join(root, 'tests', 'integration', 'fixture')], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const fixtureTar = join(tmp, 'fixture.tar')
  sh('docker', ['save', '-o', fixtureTar, fixtureTag])
  const res = spawnSync('pnpm', ['exec', 'vitest', 'run', '-c', 'vitest.integration.config.mts'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
      HELIX_IT_ANON: `127.0.0.1:${ANON_PORT}`,
      HELIX_IT_AUTH: `127.0.0.1:${AUTH_PORT}`,
      HELIX_IT_USER: USER,
      HELIX_IT_PASS: PASS,
      HELIX_IT_FIXTURE_TAR: fixtureTar,
      HELIX_IT_FIXTURE_TAG: fixtureTag,
      HELIX_IT_TMP: tmp
    }
  })
  code = res.status ?? 1
} finally {
  if (!process.env.HELIX_IT_KEEP) {
    cleanup()
    spawnSync(
      'docker',
      ['rmi', '-f', 'helix-it/fixture:1.0', `127.0.0.1:${AUTH_PORT}/test/hello:copied`, 'helix-it/extra:tag'],
      { stdio: 'ignore' }
    )
    rmSync(tmp, { recursive: true, force: true })
  }
}
process.exit(code)
