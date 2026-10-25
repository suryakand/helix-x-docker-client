import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Agent } from 'undici'
import { RegistryClient, sha256Digest } from '../../src/registry/client'

// A tiny registry that requires a bearer token from its own /token endpoint.
let server: Server
let base: string
const tokenRequests: string[] = []
const blobs = new Map<string, Buffer>()
const manifests = new Map<string, Buffer>()

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, base)
    if (url.pathname === '/token') {
      const auth = req.headers.authorization
      if (auth !== `Basic ${Buffer.from('bob:pw').toString('base64')}`) {
        res.writeHead(401).end()
        return
      }
      tokenRequests.push(url.searchParams.getAll('scope').join(' '))
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ token: 'tok', expires_in: 300 }))
      return
    }
    if (req.headers.authorization !== 'Bearer tok') {
      res.writeHead(401, { 'www-authenticate': `Bearer realm="${base}/token",service="mock"` }).end()
      return
    }
    if (url.pathname === '/v2/') return void res.writeHead(200).end('{}')
    if (url.pathname === '/v2/_catalog') {
      const last = url.searchParams.get('last')
      if (!last)
        return void res
          .writeHead(200, { link: '</v2/_catalog?last=a&n=1>; rel="next"' })
          .end(JSON.stringify({ repositories: ['a'] }))
      return void res.writeHead(200).end(JSON.stringify({ repositories: ['b'] }))
    }
    let m = /^\/v2\/(.+)\/blobs\/(sha256:[a-f0-9]+)$/.exec(url.pathname)
    if (m) {
      const b = blobs.get(m[2])
      if (!b) return void res.writeHead(404).end()
      res.writeHead(200, { 'content-length': b.length })
      return void res.end(req.method === 'HEAD' ? undefined : b)
    }
    if (/^\/v2\/.+\/blobs\/uploads\/$/.test(url.pathname) && req.method === 'POST') {
      return void res.writeHead(202, { location: '/upload/1' }).end()
    }
    if (url.pathname === '/upload/1') {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        if (req.method === 'PATCH') {
          ;(server as unknown as { pending: Buffer }).pending = Buffer.concat(chunks)
          res.writeHead(202, { location: '/upload/1' }).end()
        } else {
          const data = (server as unknown as { pending: Buffer }).pending
          blobs.set(url.searchParams.get('digest')!, data)
          res.writeHead(201).end()
        }
      })
      return
    }
    m = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname)
    if (m) {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          manifests.set(`${m![1]}:${m![2]}`, Buffer.concat(chunks))
          res.writeHead(201).end()
        })
        return
      }
      const b = manifests.get(`${m[1]}:${m[2]}`)
      if (!b)
        return void res
          .writeHead(404)
          .end(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] }))
      return void res.writeHead(200, { 'content-type': 'application/vnd.oci.image.manifest.v1+json' }).end(b)
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

const client = () =>
  new RegistryClient({
    baseUrl: base,
    dispatcher: new Agent(),
    credentials: async () => ({ username: 'bob', password: 'pw' })
  })

describe('RegistryClient (bearer flow against a mock registry)', () => {
  it('pings, follows catalog pagination and caches tokens', async () => {
    const c = client()
    await c.ping()
    expect(c.authKind).toBe('bearer')
    const p1 = await c.catalog(undefined, 1)
    expect(p1).toEqual({ items: ['a'], next: '/v2/_catalog?last=a&n=1' })
    const p2 = await c.catalog(p1.next, 1)
    expect(p2.items).toEqual(['b'])
    expect(tokenRequests.filter((s) => s === 'registry:catalog:*')).toHaveLength(1)
  })

  it('refuses cursors pointing to another host', async () => {
    await expect(client().catalog('https://evil.example.com/v2/_catalog', 1)).rejects.toThrow(/cursor/)
  })

  it('uploads a blob, pushes and reads back a manifest', async () => {
    const c = client()
    const data = Buffer.from('some layer data')
    const digest = sha256Digest(data)
    expect(await c.uploadBlob('team/app', digest, data.length, () => Readable.from([data]))).toBe(true)
    expect(blobs.get(digest)?.toString()).toBe('some layer data')
    expect(await c.uploadBlob('team/app', digest, data.length, () => Readable.from([data]))).toBe(false)
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: {},
        layers: []
      })
    )
    await c.putManifest('team/app', 'v1', manifest, 'application/vnd.oci.image.manifest.v1+json')
    const got = await c.getManifest('team/app', 'v1')
    expect(got.digest).toBe(sha256Digest(manifest))
    await expect(c.getManifest('team/app', 'missing')).rejects.toThrow(/manifest unknown/)
  })
})
