// Content addressable blob store on disk (sha256/<hex>). Downloads are verified before they become visible,
// so a cached blob is always trustworthy. Used as the persistent layer cache and as per-job scratch space.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export class DigestMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Digest mismatch: expected ${expected}, got ${actual}`)
  }
}

export function digestHex(digest: string): string {
  const m = /^sha256:([a-f0-9]{64})$/.exec(digest)
  if (!m) throw new Error(`Unsupported or invalid digest: ${digest}`)
  return m[1]
}

/**
 * A download in progress: bytes are appended to `<blob>.partial`, which survives failures so a retry (or a
 * later run) continues where it stopped. The sha256 is computed incrementally and checked on commit.
 */
export class ResumableBlob {
  private hash = createHash('sha256')
  /** Bytes already on disk (and hashed). */
  offset = 0

  private constructor(
    readonly digest: string,
    private readonly partial: string,
    private readonly final: string
  ) {}

  static async open(digest: string, final: string): Promise<ResumableBlob> {
    const blob = new ResumableBlob(digest, `${final}.partial`, final)
    await blob.resync()
    return blob
  }

  /** Make the hash and offset match the bytes actually on disk (after a crash or an interrupted write). */
  async resync(): Promise<void> {
    this.hash = createHash('sha256')
    this.offset = 0
    if (!existsSync(this.partial)) return
    for await (const chunk of createReadStream(this.partial)) {
      this.hash.update(chunk as Buffer)
      this.offset += (chunk as Buffer).length
    }
  }

  async append(source: Readable, onProgress?: (n: number) => void): Promise<void> {
    const tap = new Transform({
      transform: (chunk: Buffer, _e, cb) => {
        this.hash.update(chunk)
        this.offset += chunk.length
        onProgress?.(chunk.length)
        cb(null, chunk)
      }
    })
    try {
      await pipeline(source, tap, createWriteStream(this.partial, { flags: 'a' }))
    } catch (err) {
      // Chunks may have been hashed but not flushed to disk; re-read what really landed.
      const onDisk = existsSync(this.partial) ? statSync(this.partial).size : 0
      if (onDisk !== this.offset) await this.resync()
      throw err
    }
  }

  /** Discard partial content (e.g. the server ignored our Range request and resent from byte 0). */
  reset(): void {
    rmSync(this.partial, { force: true })
    this.hash = createHash('sha256')
    this.offset = 0
  }

  /** Verify the digest and move the file into the store. A mismatch discards the partial file. */
  commit(): void {
    const actual = `sha256:${this.hash.digest('hex')}`
    if (actual !== this.digest) {
      rmSync(this.partial, { force: true })
      throw new DigestMismatchError(this.digest, actual)
    }
    renameSync(this.partial, this.final)
  }
}

const locks = new Map<string, Promise<unknown>>()

export class BlobStore {
  constructor(
    readonly dir: string,
    private readonly maxBytes = Number.POSITIVE_INFINITY
  ) {
    mkdirSync(join(dir, 'sha256'), { recursive: true })
  }

  path(digest: string): string {
    return join(this.dir, 'sha256', digestHex(digest))
  }

  has(digest: string, size?: number): boolean {
    const p = this.path(digest)
    if (!existsSync(p)) return false
    if (size !== undefined && size >= 0 && statSync(p).size !== size) return false
    try {
      const now = new Date()
      utimesSync(p, now, now) // mark as recently used for LRU pruning
    } catch {
      /* ignore */
    }
    return true
  }

  open(digest: string): Readable {
    return createReadStream(this.path(digest))
  }

  /** Start or resume a download into the store. */
  resumable(digest: string): Promise<ResumableBlob> {
    return ResumableBlob.open(digest, this.path(digest))
  }

  /** Run `fn` exclusively per blob, so concurrent jobs never write the same partial file at once. */
  async exclusive<T>(digest: string, fn: () => Promise<T>): Promise<T> {
    const key = this.path(digest)
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
    locks.set(key, run)
    try {
      return await run
    } finally {
      if (locks.get(key) === run) locks.delete(key)
    }
  }

  /** Write a stream into the store, verifying its sha256 digest. */
  async put(digest: string, source: Readable, onProgress?: (n: number) => void): Promise<void> {
    const final = this.path(digest)
    const partial = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`
    const hash = createHash('sha256')
    const tap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        hash.update(chunk)
        onProgress?.(chunk.length)
        cb(null, chunk)
      }
    })
    try {
      await pipeline(source, tap, createWriteStream(partial))
      const actual = `sha256:${hash.digest('hex')}`
      if (actual !== digest) throw new DigestMismatchError(digest, actual)
      renameSync(partial, final)
    } catch (err) {
      rmSync(partial, { force: true })
      throw err
    }
  }

  async putBuffer(digest: string, data: Buffer): Promise<void> {
    const { Readable } = await import('node:stream')
    await this.put(digest, Readable.from([data]))
  }

  stats(): { sizeBytes: number; blobs: number } {
    let sizeBytes = 0
    let blobs = 0
    for (const f of this.entries()) {
      sizeBytes += f.size
      blobs++
    }
    return { sizeBytes, blobs }
  }

  /** Remove least recently used blobs until the store fits in maxBytes. `keep` digests are never removed. */
  prune(keep: Set<string> = new Set()): void {
    // Partial downloads are kept for resuming, but not forever.
    const dir = join(this.dir, 'sha256')
    const staleBefore = Date.now() - 7 * 24 * 3600_000
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.partial')) continue
        const p = join(dir, name)
        if (statSync(p).mtimeMs < staleBefore) rmSync(p, { force: true })
      }
    } catch {
      /* directory may not exist yet */
    }
    if (!Number.isFinite(this.maxBytes)) return
    const files = this.entries().sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = files.reduce((a, f) => a + f.size, 0)
    for (const f of files) {
      if (total <= this.maxBytes) break
      if (keep.has(`sha256:${f.name}`)) continue
      rmSync(f.path, { force: true })
      total -= f.size
    }
  }

  clear(): void {
    rmSync(join(this.dir, 'sha256'), { recursive: true, force: true })
    mkdirSync(join(this.dir, 'sha256'), { recursive: true })
  }

  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }

  private entries() {
    const dir = join(this.dir, 'sha256')
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    return names
      .filter((n) => /^[a-f0-9]{64}$/.test(n))
      .map((name) => {
        const path = join(dir, name)
        const s = statSync(path)
        return { name, path, size: s.size, mtimeMs: s.mtimeMs }
      })
  }
}
