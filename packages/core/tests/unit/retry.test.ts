import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Agent } from 'undici'
import { RegistryClient } from '../../src/registry/client'
import { parseRetryAfter } from '../../src/registry/errors'
import { BlobStore } from '../../src/transfer/blob-store'
import { fetchBlob } from '../../src/transfer/operations'

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`
const BLOB = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 251))
const BLOB_DIGEST = sha(BLOB)

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void
let handler: Handler
let server: Server
let base: string
const log: { method: string; path: string; range?: string }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('error', () => undefined)
    req.on('end', () => {
      log.push({ method: req.method!, path: req.url!, range: req.headers.range })
      handler(req, res, Buffer.concat(chunks))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
beforeEach(() => {
  log.length = 0
})

const client = (creds = false) =>
  new RegistryClient({
    baseUrl: base,
    dispatcher: new Agent(),
    credentials: async () => (creds ? { username: 'u', password: 'p' } : null),
    retry: { baseDelayMs: 1, maxDelayMs: 20 }
  })

describe('retries', () => {
  it('retries 503 / 429 honouring Retry-After, then succeeds', async () => {
    let n = 0
    handler = (_req, res) => {
      n++
      if (n === 1) return void res.writeHead(503, { 'retry-after': '0' }).end()
      if (n === 2) return void res.writeHead(429, { 'retry-after': '0' }).end()
      res.writeHead(200).end('{}')
    }
    await client().ping()
    expect(n).toBe(3)
  })

  it('does not retry permanent errors', async () => {
    handler = (_req, res) => void res.writeHead(404).end()
    await expect(client().ping()).rejects.toThrow(/Not found/)
    expect(log).toHaveLength(1)
  })

  it('gives up after the configured attempts', async () => {
    handler = (_req, res) => void res.writeHead(502).end()
    await expect(client().ping()).rejects.toThrow(/HTTP 502/)
    expect(log).toHaveLength(4)
  })

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000)
    expect(parseRetryAfter('nonsense')).toBeUndefined()
  })
})

describe('resumable blob download', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'resume-'))
  })

  /** Serves the blob, answering Range requests with 206 when `honourRange` is set (otherwise 200 + full body). */
  function rangeServer(honourRange: boolean): Handler {
    return (req, res) => {
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
      if (m && honourRange) {
        const start = Number(m[1])
        res.writeHead(206, {
          'content-length': BLOB.length - start,
          'content-range': `bytes ${start}-${BLOB.length - 1}/${BLOB.length}`
        })
        return void res.end(BLOB.subarray(start))
      }
      res.writeHead(200, { 'content-length': BLOB.length }).end(BLOB)
    }
  }

  /** A partial download left behind by an earlier, interrupted attempt. */
  async function seedPartial(store: BlobStore, bytes: number) {
    const partial = await store.resumable(BLOB_DIGEST)
    await partial.append(Readable.from([BLOB.subarray(0, bytes)]))
  }

  const fetchInto = (store: BlobStore, progress: { add: (n: number) => void }) =>
    fetchBlob(client(), 'r', { digest: BLOB_DIGEST, size: BLOB.length }, store, {
      signal: new AbortController().signal,
      progress,
      retry: { baseDelayMs: 1 }
    })

  it('resumes from the bytes on disk with an HTTP Range request', async () => {
    handler = rangeServer(true)
    const store = new BlobStore(dir)
    await seedPartial(store, 100_000)
    let progress = 0
    await fetchInto(store, { add: (n) => (progress += n) })
    expect(store.has(BLOB_DIGEST, BLOB.length)).toBe(true)
    expect(progress).toBe(BLOB.length)
    expect(log).toHaveLength(1)
    expect(log[0].range).toBe('bytes=100000-')
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts over when the server ignores Range', async () => {
    handler = rangeServer(false)
    const store = new BlobStore(dir)
    await seedPartial(store, 100_000)
    let progress = 0
    await fetchInto(store, { add: (n) => (progress += n) })
    expect(log[0].range).toBe('bytes=100000-')
    expect(store.has(BLOB_DIGEST, BLOB.length)).toBe(true)
    expect(progress).toBe(BLOB.length)
    rmSync(dir, { recursive: true, force: true })
  })

  it('retries a download whose connection drops mid-stream', async () => {
    // How many of the first bytes reach disk before the drop is timing dependent (chunks still queued in
    // the response stream are discarded when it errors), so only the guaranteed outcome is asserted:
    // the blob completes, verifies, and progress is counted exactly once.
    let first = true
    const serve = rangeServer(true)
    handler = (req, res, body) => {
      if (!first) return serve(req, res, body)
      first = false
      res.writeHead(200, { 'content-length': BLOB.length })
      res.write(BLOB.subarray(0, 100_000), () => setTimeout(() => res.destroy(), 20))
    }
    const store = new BlobStore(dir)
    let progress = 0
    await fetchInto(store, { add: (n) => (progress += n) })
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(store.has(BLOB_DIGEST, BLOB.length)).toBe(true)
    expect(progress).toBe(BLOB.length)
    expect((await store.resumable(BLOB_DIGEST)).offset).toBe(0) // no leftover partial file
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects corrupted content and discards the partial file', async () => {
    handler = (_req, res) => void res.writeHead(200).end(Buffer.from('not the blob'))
    const store = new BlobStore(dir)
    await expect(
      fetchBlob(client(), 'r', { digest: BLOB_DIGEST, size: BLOB.length }, store, {
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/Digest mismatch/)
    expect((await store.resumable(BLOB_DIGEST)).offset).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('upload restarts', () => {
  function registry(opts: { failFirstPatch: 'reset' | 'expired-token' }): Handler {
    let patches = 0
    let tokens = 0
    const uploaded = new Map<string, Buffer>()
    let pending: Buffer = Buffer.alloc(0)
    const authed = (req: IncomingMessage) => req.headers.authorization === `Bearer t${tokens}`
    return (req, res, body) => {
      const url = new URL(req.url!, base)
      if (opts.failFirstPatch === 'expired-token') {
        if (url.pathname === '/token') {
          tokens++
          return void res.writeHead(200).end(JSON.stringify({ token: `t${tokens}`, expires_in: 300 }))
        }
        if (!authed(req))
          return void res
            .writeHead(401, { 'www-authenticate': `Bearer realm="${base}/token",service="x"` })
            .end()
      }
      if (req.method === 'HEAD')
        return void res.writeHead(uploaded.has(url.pathname.split('/').pop()!) ? 200 : 404).end()
      if (req.method === 'POST') return void res.writeHead(202, { location: '/upload' }).end()
      if (req.method === 'PATCH') {
        patches++
        if (patches === 1 && opts.failFirstPatch === 'reset') return void res.destroy()
        if (patches === 1 && opts.failFirstPatch === 'expired-token') {
          tokens++ // the token we handed out is no longer valid
          return void res
            .writeHead(401, { 'www-authenticate': `Bearer realm="${base}/token",service="x"` })
            .end()
        }
        pending = body
        return void res.writeHead(202, { location: '/upload' }).end()
      }
      if (req.method === 'PUT') {
        uploaded.set(url.searchParams.get('digest')!, pending)
        return void res.writeHead(201).end()
      }
      res.writeHead(404).end()
    }
  }

  for (const mode of ['reset', 'expired-token'] as const) {
    it(`restarts the upload session after ${mode}`, async () => {
      handler = registry({ failFirstPatch: mode })
      let progress = 0
      const uploaded = await client(true).uploadBlob(
        'r',
        BLOB_DIGEST,
        BLOB.length,
        () => Readable.from([BLOB]),
        {
          onProgress: (n) => (progress += n)
        }
      )
      expect(uploaded).toBe(true)
      expect(progress).toBe(BLOB.length)
      expect(log.filter((l) => l.method === 'POST')).toHaveLength(2)
      expect(log.filter((l) => l.method === 'PUT')).toHaveLength(1)
    })
  }
})
