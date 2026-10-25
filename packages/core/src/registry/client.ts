import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { fetch, type Dispatcher, type Response } from 'undici'
import {
  basicHeader,
  CATALOG_SCOPE,
  parseNextLink,
  parseWwwAuthenticate,
  repoScope,
  type BasicCredentials,
  type Challenge
} from './auth'
import { errorFromResponse, networkError, RegistryError } from './errors'
import { USER_AGENT } from './http'
import { MANIFEST_ACCEPT } from './media'
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from './retry'

export interface RegistryClientOptions {
  /** Base URL without /v2, e.g. https://registry.example.com */
  baseUrl: string
  dispatcher: Dispatcher
  credentials: () => Promise<BasicCredentials | null>
  /** Retry policy for transient failures (defaults to DEFAULT_RETRY). */
  retry?: Partial<RetryPolicy>
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: Buffer | Readable | null
  scopes?: string[]
  signal?: AbortSignal
  /** Statuses treated as success (default: 2xx). */
  ok?: number[]
  what?: string
}

export interface ManifestResult {
  bytes: Buffer
  mediaType: string
  digest: string
}

export interface UploadOptions {
  signal?: AbortSignal
  onProgress?: (bytes: number) => void
  /** Repository on the same registry that already has the blob (cross-repository mount). */
  mountFrom?: string
}

interface TokenEntry {
  header: string
  expiresAt: number
}

type AuthMode =
  { kind: 'unknown' } | { kind: 'anonymous' } | { kind: 'basic' } | { kind: 'bearer'; challenge: Challenge }

export function sha256Digest(data: Buffer | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/** Docker Registry HTTP API v2 / OCI Distribution client. */
export class RegistryClient {
  private mode: AuthMode = { kind: 'unknown' }
  private tokens = new Map<string, TokenEntry>()
  private creds: BasicCredentials | null | undefined
  private readonly retry: RetryPolicy

  constructor(private readonly opts: RegistryClientOptions) {
    this.retry = { ...DEFAULT_RETRY, ...opts.retry }
  }

  get baseUrl(): string {
    return this.opts.baseUrl
  }

  get authKind(): AuthMode['kind'] {
    return this.mode.kind
  }

  // ------------------------------------------------------------------ high level API

  /** GET /v2/ — verifies connectivity and credentials. */
  async ping(signal?: AbortSignal): Promise<void> {
    const res = await this.request('/v2/', { signal, what: 'registry API (/v2/)' })
    await res.body?.cancel()
  }

  async catalog(cursor: string | undefined, pageSize: number): Promise<{ items: string[]; next?: string }> {
    const path = cursor ? this.cursorPath(cursor) : `/v2/_catalog?n=${pageSize}`
    const res = await this.request(path, { scopes: [CATALOG_SCOPE], what: 'repository catalog' })
    const body = (await res.json()) as { repositories?: string[] }
    return { items: body.repositories ?? [], next: this.nextCursor(res) }
  }

  async tags(
    repo: string,
    cursor: string | undefined,
    pageSize: number
  ): Promise<{ items: string[]; next?: string }> {
    const path = cursor ? this.cursorPath(cursor) : `/v2/${repo}/tags/list?n=${pageSize}`
    const res = await this.request(path, { scopes: [repoScope(repo, ['pull'])], what: `tags of ${repo}` })
    const body = (await res.json()) as { tags?: string[] | null }
    return { items: body.tags ?? [], next: this.nextCursor(res) }
  }

  /** Pagination cursors are same-origin /v2/ paths; never follow them to another host with our credentials. */
  private cursorPath(cursor: string): string {
    const u = new URL(cursor, this.opts.baseUrl)
    if (u.origin !== new URL(this.opts.baseUrl).origin || !u.pathname.startsWith('/v2/')) {
      throw new RegistryError('Invalid pagination cursor', 'PROTOCOL')
    }
    return `${u.pathname}${u.search}`
  }

  private nextCursor(res: Response): string | undefined {
    const next = parseNextLink(res.headers.get('link'))
    if (!next) return undefined
    try {
      return this.cursorPath(next)
    } catch {
      return undefined
    }
  }

  async getManifest(repo: string, ref: string, signal?: AbortSignal): Promise<ManifestResult> {
    const res = await this.request(`/v2/${repo}/manifests/${ref}`, {
      headers: { Accept: MANIFEST_ACCEPT },
      scopes: [repoScope(repo, ['pull'])],
      signal,
      what: `manifest ${repo}:${ref}`
    })
    const bytes = Buffer.from(await res.arrayBuffer())
    const computed = sha256Digest(bytes)
    if (ref.startsWith('sha256:') && ref !== computed) {
      throw new RegistryError(`Manifest digest mismatch for ${repo}@${ref}`, 'DIGEST_MISMATCH')
    }
    let mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as { mediaType?: string }
      if (parsed.mediaType) mediaType = parsed.mediaType
    } catch {
      throw new RegistryError(`Manifest for ${repo}:${ref} is not valid JSON`, 'PROTOCOL')
    }
    return { bytes, mediaType, digest: computed }
  }

  /** Resolve a tag to its digest without downloading the manifest body. */
  async headManifest(
    repo: string,
    ref: string
  ): Promise<{ digest: string; mediaType: string; size: number } | null> {
    const res = await this.request(`/v2/${repo}/manifests/${ref}`, {
      method: 'HEAD',
      headers: { Accept: MANIFEST_ACCEPT },
      scopes: [repoScope(repo, ['pull'])],
      ok: [200, 404],
      what: `manifest ${repo}:${ref}`
    })
    if (res.status === 404) return null
    const digest = res.headers.get('docker-content-digest')
    if (!digest) return null
    return {
      digest,
      mediaType: (res.headers.get('content-type') ?? '').split(';')[0].trim(),
      size: Number(res.headers.get('content-length') ?? 0)
    }
  }

  async getBlobBytes(repo: string, digest: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.request(`/v2/${repo}/blobs/${digest}`, {
      scopes: [repoScope(repo, ['pull'])],
      signal,
      what: `blob ${digest.slice(0, 19)}`
    })
    const bytes = Buffer.from(await res.arrayBuffer())
    if (sha256Digest(bytes) !== digest)
      throw new RegistryError(`Blob digest mismatch for ${digest}`, 'DIGEST_MISMATCH')
    return bytes
  }

  /**
   * Stream a blob, optionally starting at `offset` (HTTP Range) to resume an interrupted download.
   * `offset` in the result is where the returned stream actually starts: 0 when the server ignored the range.
   * The caller is responsible for verifying the digest (see transfer/blob-store).
   */
  async getBlobStream(
    repo: string,
    digest: string,
    signal?: AbortSignal,
    offset = 0
  ): Promise<{ stream: Readable; size: number; offset: number }> {
    const res = await this.request(`/v2/${repo}/blobs/${digest}`, {
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
      scopes: [repoScope(repo, ['pull'])],
      signal,
      what: `blob ${digest.slice(0, 19)}`
    })
    if (!res.body) throw new RegistryError(`Empty response body for blob ${digest}`, 'PROTOCOL')
    return {
      stream: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      size: Number(res.headers.get('content-length') ?? -1),
      offset: res.status === 206 ? offset : 0
    }
  }

  async blobExists(repo: string, digest: string, signal?: AbortSignal): Promise<boolean> {
    const res = await this.request(`/v2/${repo}/blobs/${digest}`, {
      method: 'HEAD',
      scopes: [repoScope(repo, ['pull', 'push'])],
      ok: [200, 404],
      signal,
      what: `blob ${digest.slice(0, 19)}`
    })
    return res.status === 200
  }

  /**
   * Upload a blob unless it already exists. Tries a cross-repository mount first when `mountFrom` is given,
   * then streams the content as a single PATCH followed by the closing PUT.
   * A transient failure (or a token expiring mid-upload) restarts the upload session with a fresh stream.
   * Returns false when the blob was already present (or mounted) and nothing was uploaded.
   */
  async uploadBlob(
    repo: string,
    digest: string,
    size: number,
    open: () => Readable | Promise<Readable>,
    opts: UploadOptions = {}
  ): Promise<boolean> {
    let reported = 0
    const onProgress = (n: number) => {
      reported += n
      opts.onProgress?.(n)
    }
    return withRetry(
      () => this.uploadOnce(repo, digest, size, open, { ...opts, onProgress }),
      this.retry,
      opts.signal,
      () => {
        // The restarted upload streams from the beginning again.
        opts.onProgress?.(-reported)
        reported = 0
      }
    )
  }

  private async uploadOnce(
    repo: string,
    digest: string,
    size: number,
    open: () => Readable | Promise<Readable>,
    opts: UploadOptions
  ): Promise<boolean> {
    const scopes = [repoScope(repo, ['pull', 'push'])]
    if (await this.blobExists(repo, digest, opts.signal)) {
      opts.onProgress?.(size)
      return false
    }
    let location: string | undefined
    if (opts.mountFrom && opts.mountFrom !== repo) {
      const res = await this.request(
        `/v2/${repo}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(opts.mountFrom)}`,
        {
          method: 'POST',
          headers: { 'Content-Length': '0' },
          scopes: [...scopes, repoScope(opts.mountFrom, ['pull'])],
          ok: [201, 202],
          signal: opts.signal,
          what: `mount ${digest.slice(0, 19)}`
        }
      )
      await res.body?.cancel()
      if (res.status === 201) {
        opts.onProgress?.(size)
        return false
      }
      location = res.headers.get('location') ?? undefined
    }
    if (!location) {
      const res = await this.request(`/v2/${repo}/blobs/uploads/`, {
        method: 'POST',
        headers: { 'Content-Length': '0' },
        scopes,
        ok: [202],
        signal: opts.signal,
        what: `start upload to ${repo}`
      })
      await res.body?.cancel()
      location = res.headers.get('location') ?? undefined
      if (!location) throw new RegistryError('Registry did not return an upload location', 'PROTOCOL')
    }

    if (size > 0) {
      const source = await open()
      const counted = source.pipe(progressCounter(opts.onProgress))
      source.on('error', (e) => counted.destroy(e))
      const res = await this.request(location, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
          'Content-Range': `0-${size - 1}`
        },
        body: counted,
        scopes,
        ok: [202, 204],
        signal: opts.signal,
        what: `upload ${digest.slice(0, 19)}`
      })
      await res.body?.cancel()
      location = res.headers.get('location') ?? location
    }
    const sep = location.includes('?') ? '&' : '?'
    const res = await this.request(`${location}${sep}digest=${encodeURIComponent(digest)}`, {
      method: 'PUT',
      headers: { 'Content-Length': '0', 'Content-Type': 'application/octet-stream' },
      scopes,
      ok: [201, 204],
      signal: opts.signal,
      what: `finish upload ${digest.slice(0, 19)}`
    })
    await res.body?.cancel()
    return true
  }

  async putManifest(
    repo: string,
    ref: string,
    bytes: Buffer,
    mediaType: string,
    signal?: AbortSignal
  ): Promise<string> {
    const res = await this.request(`/v2/${repo}/manifests/${ref}`, {
      method: 'PUT',
      headers: { 'Content-Type': mediaType, 'Content-Length': String(bytes.length) },
      body: bytes,
      scopes: [repoScope(repo, ['pull', 'push'])],
      ok: [200, 201, 202],
      signal,
      what: `manifest ${repo}:${ref}`
    })
    await res.body?.cancel()
    return res.headers.get('docker-content-digest') ?? sha256Digest(bytes)
  }

  async deleteManifest(repo: string, digest: string): Promise<void> {
    const res = await this.request(`/v2/${repo}/manifests/${digest}`, {
      method: 'DELETE',
      scopes: [repoScope(repo, ['pull', 'push', 'delete'])],
      ok: [200, 202],
      what: `delete ${repo}@${digest.slice(0, 19)}`
    })
    await res.body?.cancel()
  }

  // ------------------------------------------------------------------ transport + auth

  /**
   * Send a request with authentication. Requests without a streaming body are retried on transient
   * failures (connection resets, timeouts, 429/502/503/504 honouring Retry-After).
   */
  async request(pathOrUrl: string, o: RequestOptions = {}): Promise<Response> {
    const replayable = !(o.body instanceof Readable)
    if (!replayable) return this.attempt(pathOrUrl, o, false)
    return withRetry(() => this.attempt(pathOrUrl, o, true), this.retry, o.signal)
  }

  private async attempt(pathOrUrl: string, o: RequestOptions, replayable: boolean): Promise<Response> {
    const url = new URL(pathOrUrl, this.opts.baseUrl).toString()
    const scopes = o.scopes ?? []
    let auth = await this.authorizationFor(scopes)
    let res = await this.send(url, o, auth)

    if (res.status === 401) {
      const challenges = parseWwwAuthenticate(res.headers.get('www-authenticate'))
      await res.body?.cancel()
      auth = await this.handleChallenge(challenges, scopes)
      if (auth === undefined) throw await errorFromResponse(res, o.what ?? url)
      if (!replayable) {
        // A streamed body cannot be resent. The token is refreshed now; the caller restarts the upload.
        throw new RegistryError(
          `Authentication expired during ${o.what ?? 'upload'}; retrying with a fresh token`,
          'UNAUTHORIZED',
          401,
          { retryable: true, retryAfterMs: 0 }
        )
      }
      res = await this.send(url, o, auth)
    }

    const ok = o.ok ?? []
    if ((res.status >= 200 && res.status < 300 && ok.length === 0) || ok.includes(res.status)) return res
    throw await errorFromResponse(res, o.what ?? url)
  }

  private async send(url: string, o: RequestOptions, authorization?: string): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, ...(o.headers ?? {}) }
    if (authorization) headers.Authorization = authorization
    try {
      return await fetch(url, {
        method: o.method ?? 'GET',
        headers,
        body: o.body ?? undefined,
        dispatcher: this.opts.dispatcher,
        signal: o.signal,
        redirect: 'follow',
        ...(o.body instanceof Readable ? { duplex: 'half' } : {})
      } as Parameters<typeof fetch>[1])
    } catch (err) {
      throw networkError(err, url)
    }
  }

  private async credentials(): Promise<BasicCredentials | null> {
    if (this.creds === undefined) this.creds = await this.opts.credentials()
    return this.creds
  }

  /** Authorization header to send proactively, based on what the registry asked for previously. */
  private async authorizationFor(scopes: string[]): Promise<string | undefined> {
    switch (this.mode.kind) {
      case 'basic': {
        const c = await this.credentials()
        return c ? basicHeader(c) : undefined
      }
      case 'bearer':
        return this.bearerToken(this.mode.challenge, scopes)
      default:
        return undefined
    }
  }

  private async handleChallenge(challenges: Challenge[], scopes: string[]): Promise<string | undefined> {
    const bearer = challenges.find((c) => c.scheme === 'bearer')
    if (bearer?.params.realm) {
      this.mode = { kind: 'bearer', challenge: bearer }
      const wanted = new Set(scopes)
      if (bearer.params.scope) bearer.params.scope.split(' ').forEach((s) => wanted.add(s))
      return this.bearerToken(bearer, [...wanted], true)
    }
    if (challenges.some((c) => c.scheme === 'basic')) {
      const c = await this.credentials()
      if (!c) return undefined
      this.mode = { kind: 'basic' }
      return basicHeader(c)
    }
    return undefined
  }

  private async bearerToken(challenge: Challenge, scopes: string[], force = false): Promise<string> {
    const key = `${challenge.params.realm}|${challenge.params.service ?? ''}|${[...scopes].sort().join(' ')}`
    const cached = this.tokens.get(key)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.header

    const url = new URL(challenge.params.realm)
    if (challenge.params.service) url.searchParams.set('service', challenge.params.service)
    for (const s of scopes) url.searchParams.append('scope', s)
    const creds = await this.credentials()
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
    if (creds) headers.Authorization = basicHeader(creds)

    let res: Response
    try {
      res = await fetch(url, { headers, dispatcher: this.opts.dispatcher })
    } catch (err) {
      throw networkError(err, url.toString())
    }
    if (!res.ok) throw await errorFromResponse(res, `token from ${url.host}`)
    const body = (await res.json()) as { token?: string; access_token?: string; expires_in?: number }
    const token = body.token ?? body.access_token
    if (!token) throw new RegistryError(`Token service ${url.host} returned no token`, 'PROTOCOL')
    const ttl = Math.max(30, body.expires_in ?? 60)
    const header = `Bearer ${token}`
    // Refresh a little early so long transfers do not hit an expired token.
    this.tokens.set(key, { header, expiresAt: Date.now() + (ttl - 10) * 1000 })
    return header
  }
}

function progressCounter(onProgress?: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onProgress?.(chunk.length)
      cb(null, chunk)
    }
  })
}
