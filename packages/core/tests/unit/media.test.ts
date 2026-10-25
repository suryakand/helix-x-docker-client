import { describe, expect, it } from 'vitest'
import { normalizeArch, parsePlatform, selectManifest, type ImageIndex } from '../../src/registry/media'

const index: ImageIndex = {
  schemaVersion: 2,
  manifests: [
    {
      mediaType: 'm',
      digest: 'sha256:a',
      size: 1,
      platform: { os: 'linux', architecture: 'arm', variant: 'v6' }
    },
    {
      mediaType: 'm',
      digest: 'sha256:b',
      size: 1,
      platform: { os: 'linux', architecture: 'arm', variant: 'v7' }
    },
    { mediaType: 'm', digest: 'sha256:c', size: 1, platform: { os: 'linux', architecture: 'amd64' } },
    {
      mediaType: 'm',
      digest: 'sha256:d',
      size: 1,
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: { 'vnd.docker.reference.type': 'attestation-manifest' }
    }
  ]
}

describe('selectManifest', () => {
  it('prefers linux/amd64 by default and ignores attestations', () => {
    expect(selectManifest(index)?.digest).toBe('sha256:c')
  })
  it('matches variant exactly when asked', () => {
    expect(selectManifest(index, { os: 'linux', architecture: 'arm', variant: 'v7' })?.digest).toBe(
      'sha256:b'
    )
  })
  it('returns undefined when the platform is missing', () => {
    expect(selectManifest(index, { os: 'windows', architecture: 'amd64' })).toBeUndefined()
  })
})

describe('platform helpers', () => {
  it('normalizes architectures and parses strings', () => {
    expect(normalizeArch('x64')).toEqual({ architecture: 'amd64' })
    expect(normalizeArch('aarch64')).toEqual({ architecture: 'arm64' })
    expect(parsePlatform('linux/arm/v7')).toEqual({ os: 'linux', architecture: 'arm', variant: 'v7' })
    expect(parsePlatform('bad')).toBeUndefined()
  })
})
