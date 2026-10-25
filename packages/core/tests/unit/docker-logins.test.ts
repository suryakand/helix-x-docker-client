import { describe, expect, it } from 'vitest'
import { mapDockerLogin, readDockerLogins, type DockerLoginsEnv } from '../../src/store/docker-logins'

const b64 = (s: string) => Buffer.from(s).toString('base64')

function env(
  config: object,
  helpers: Record<string, Record<string, { Username: string; Secret: string }>> = {}
): DockerLoginsEnv {
  return {
    configPath: '/home/me/.docker/config.json',
    exists: () => true,
    read: () => JSON.stringify(config),
    runHelper: async (helper, action, input) => {
      const store = helpers[helper]
      if (!store) throw new Error(`docker-credential-${helper} is not installed or not on PATH`)
      if (action === 'list')
        return JSON.stringify(Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.Username])))
      const hit = store[input ?? '']
      if (!hit) throw new Error('credentials not found in native keychain')
      return JSON.stringify({ ServerURL: input, ...hit })
    }
  }
}

describe('readDockerLogins', () => {
  it('reads inline auths, per-registry helpers and the default credential store', async () => {
    const { logins, warnings } = await readDockerLogins(
      env(
        {
          auths: {
            'registry.local:5000': { auth: b64('alice:pa:ss') },
            'https://index.docker.io/v1/': {},
            'ghcr.io': {}
          },
          credsStore: 'desktop',
          credHelpers: { 'ghcr.io': 'gh' }
        },
        {
          desktop: {
            'https://index.docker.io/v1/': { Username: 'bob', Secret: 'dckr_pat_x' },
            'https://index.docker.io/v1/access-token': { Username: 'bob', Secret: 'oauth' },
            'myreg.azurecr.io': { Username: 'sp-id', Secret: 'sp-secret' }
          },
          gh: { 'ghcr.io': { Username: 'carol', Secret: 'ghp_y' } }
        }
      )
    )
    const byServer = Object.fromEntries(logins.map((l) => [l.server, l]))
    expect(byServer['registry.local:5000']).toMatchObject({
      username: 'alice',
      secret: 'pa:ss',
      source: 'config.json'
    })
    expect(byServer['https://index.docker.io/v1/']).toMatchObject({
      username: 'bob',
      source: 'helper: desktop'
    })
    expect(byServer['ghcr.io']).toMatchObject({ username: 'carol', source: 'helper: gh' })
    expect(byServer['myreg.azurecr.io']).toMatchObject({ username: 'sp-id' })
    expect(byServer['https://index.docker.io/v1/access-token']).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('reports a missing helper as a warning instead of failing', async () => {
    const { logins, warnings } = await readDockerLogins(
      env({ auths: { 'x.io': {} }, credsStore: 'osxkeychain' })
    )
    expect(logins).toEqual([])
    expect(warnings.join(' ')).toMatch(/docker-credential-osxkeychain is not installed/)
  })

  it('handles a missing config file', async () => {
    const { logins, warnings } = await readDockerLogins({ ...env({}), exists: () => false })
    expect(logins).toEqual([])
    expect(warnings[0]).toMatch(/does not exist/)
  })
})

describe('mapDockerLogin', () => {
  const login = (server: string, username = 'u', secret = 's') => ({
    server,
    username,
    secret,
    source: 'config.json'
  })

  it('maps well-known registries to their provider types', () => {
    expect(mapDockerLogin(login('https://index.docker.io/v1/', 'bob'))).toMatchObject({
      type: 'dockerhub',
      url: 'https://registry-1.docker.io',
      namespace: 'bob',
      credentials: { username: 'bob', password: 's' }
    })
    expect(mapDockerLogin(login('ghcr.io')).type).toBe('ghcr')
    expect(mapDockerLogin(login('myreg.azurecr.io')).type).toBe('acr')
    expect(mapDockerLogin(login('registry.gitlab.com')).type).toBe('gitlab')
  })

  it('maps GCP service-account and access-token logins to the Google provider fields', () => {
    expect(
      mapDockerLogin(login('us-docker.pkg.dev', '_json_key', '{"type":"service_account"}'))
    ).toMatchObject({
      type: 'gcr',
      credentials: { serviceAccountJson: '{"type":"service_account"}' }
    })
    expect(mapDockerLogin(login('gcr.io', 'oauth2accesstoken', 'ya29')).credentials).toEqual({
      accessToken: 'ya29'
    })
  })

  it('refuses short-lived ECR tokens and identity tokens outside ACR', () => {
    expect(mapDockerLogin(login('123456789012.dkr.ecr.eu-west-1.amazonaws.com', 'AWS')).supported).toBe(false)
    expect(mapDockerLogin(login('quay.io', '<token>')).supported).toBe(false)
    expect(mapDockerLogin(login('myreg.azurecr.io', '<token>', 'refresh')).credentials).toEqual({
      username: '00000000-0000-0000-0000-000000000000',
      password: 'refresh'
    })
  })

  it('uses plain HTTP for localhost registries', () => {
    expect(mapDockerLogin(login('localhost:5000'))).toMatchObject({
      type: 'generic',
      url: 'http://localhost:5000',
      plainHttp: true
    })
    expect(mapDockerLogin(login('registry.example.com'))).toMatchObject({
      url: 'https://registry.example.com',
      plainHttp: false
    })
  })
})
