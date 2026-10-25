import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { resolveEndpoint, type EndpointEnv } from '../../src/docker/endpoint'

function env(files: Record<string, string>, over: Partial<EndpointEnv> = {}): EndpointEnv {
  return {
    env: {},
    platform: 'darwin',
    home: '/Users/me',
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    ...over
  }
}

describe('resolveEndpoint', () => {
  it('prefers the settings override, then DOCKER_HOST', () => {
    expect(resolveEndpoint('tcp://h:2375', env({})).source).toBe('settings')
    const e = resolveEndpoint('', env({}, { env: { DOCKER_HOST: 'unix:///tmp/d.sock' } }))
    expect(e).toMatchObject({ uri: 'unix:///tmp/d.sock', source: 'DOCKER_HOST' })
  })

  it('follows the current docker context', () => {
    const hash = createHash('sha256').update('desktop-linux').digest('hex')
    const files = {
      '/Users/me/.docker/config.json': JSON.stringify({ currentContext: 'desktop-linux' }),
      [`/Users/me/.docker/contexts/meta/${hash}/meta.json`]: JSON.stringify({
        Endpoints: { docker: { Host: 'unix:///Users/me/.docker/run/docker.sock' } }
      })
    }
    expect(resolveEndpoint('', env(files))).toMatchObject({
      uri: 'unix:///Users/me/.docker/run/docker.sock',
      source: 'context',
      contextName: 'desktop-linux'
    })
  })

  it('falls back to the first existing default socket', () => {
    const e = resolveEndpoint('', env({ '/Users/me/.colima/default/docker.sock': '' }))
    expect(e).toMatchObject({ uri: 'unix:///Users/me/.colima/default/docker.sock', source: 'default' })
    expect(resolveEndpoint('', env({})).source).toBe('none')
    expect(resolveEndpoint('', env({}, { platform: 'win32' })).uri).toBe('npipe:////./pipe/docker_engine')
  })
})
