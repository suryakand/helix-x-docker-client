import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RegistryService } from '../../src/registry/service'
import { defaultSettings } from '../../src/store/defaults'
import { RegistryStore } from '../../src/store/registries'
import { Vault } from '../../src/vault/vault'

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`
const config = Buffer.from(
  JSON.stringify({ created: '2026-01-02T03:04:05Z', os: 'linux', architecture: 'amd64' })
)
const manifest = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: sha(config),
      size: config.length
    },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: `sha256:${'a'.repeat(64)}`,
        size: 1000
      }
    ]
  })
)

let server: Server
let base: string
let inFlight = 0
let maxInFlight = 0
const requests: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    requests.push(`${req.method} ${req.url}`)
    setTimeout(() => {
      inFlight--
      const url = req.url!
      if (/\/manifests\//.test(url)) {
        res.writeHead(200, {
          'content-type': 'application/vnd.oci.image.manifest.v1+json',
          'docker-content-digest': sha(manifest),
          'content-length': manifest.length
        })
        return void res.end(req.method === 'HEAD' ? undefined : manifest)
      }
      if (url.endsWith(`/blobs/${sha(config)}`)) return void res.writeHead(200).end(config)
      res.writeHead(404).end()
    }, 20)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('RegistryService.tagSummary', () => {
  it('caps concurrency and serves tags with a known digest from cache via HEAD only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'summary-'))
    const store = new RegistryStore(join(dir, 'registries.json'), new Vault(join(dir, 'vault.json')))
    const svc = new RegistryService(
      store,
      () => defaultSettings(dir),
      () => 100
    )
    const { id } = store.create({
      config: {
        name: 'mock',
        type: 'generic',
        url: base,
        color: '#000',
        tls: { insecureSkipVerify: false, plainHttp: true }
      }
    })

    const first = await Promise.all(
      Array.from({ length: 12 }, (_, i) => svc.tagSummary(id, 'team/app', `v${i}`))
    )
    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(first[5]).toMatchObject({
      tag: 'v5',
      digest: sha(manifest),
      size: config.length + 1000,
      created: '2026-01-02T03:04:05Z'
    })

    requests.length = 0
    const second = await Promise.all(
      Array.from({ length: 12 }, (_, i) => svc.tagSummary(id, 'team/app', `w${i}`))
    )
    expect(second.map((s) => s.tag)).toEqual(Array.from({ length: 12 }, (_, i) => `w${i}`))
    expect(requests.every((r) => r.startsWith('HEAD /v2/team/app/manifests/'))).toBe(true)
    expect(requests).toHaveLength(12)
    rmSync(dir, { recursive: true, force: true })
  })
})
