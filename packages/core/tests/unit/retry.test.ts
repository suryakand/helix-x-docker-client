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

  /** First request: send the first `cut` bytes, then kill the connection. */
  function flaky(cut: number, honourRange: boolean): Handler {
    let first = true
    return (req, res) => {
      if (first) {
        first = false
        res.writeHead(200, { 'content-length': BLOB.length })
        res.write(BLOB.subarray(0, cut), () => setTimeout(() => res.destroy(), 20))
        return
      }
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

  it('resumes from the bytes on disk with an HTTP Range request', async () => {
    handler = flaky(100_000, true)
    const store = new BlobStore(dir)
    let progress = 0
    await fetchBlob(client(), 'r', { digest: BLOB_DIGEST, size: BLOB.length }, store, {
      signal: new AbortController().signal,
      progress: { add: (n) => (progress += n) },
      retry: { baseDelayMs: 1 }
    })
    expect(store.has(BLOB_DIGEST, BLOB.length)).toBe(true)
    expect(progress).toBe(BLOB.length)
    const second = log[1]
    expect(second.range).toMatch(/^bytes=\d+-$/)
    expect(Number(/\d+/.exec(second.range!)![0])).toBeGreaterThan(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts over when the server ignores Range', async () => {
    handler = flaky(100_000, false)
    const store = new BlobStore(dir)
    let progress = 0
    await fetchBlob(client(), 'r', { digest: BLOB_DIGEST, size: BLOB.length }, store, {
      signal: new AbortController().signal,
      progress: { add: (n) => (progress += n) },
      retry: { baseDelayMs: 1 }
    })
    expect(store.has(BLOB_DIGEST, BLOB.length)).toBe(true)
    expect(progress).toBe(BLOB.length)
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
