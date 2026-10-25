import type { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import type { RegistryClient } from '../registry/client'
import type { ImageManifest, ManifestDescriptor } from '../registry/media'
import type { BlobStore } from './blob-store'
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from '../registry/retry'

export interface Progress {
  add(bytes: number): void
}

export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  let failed: unknown
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length && failed === undefined) {
      const item = items[i++]
      try {
        await fn(item)
      } catch (err) {
        failed ??= err
      }
    }
  })
  await Promise.all(workers)
  if (failed !== undefined) throw failed
}

export function blobsOf(m: ImageManifest): ManifestDescriptor[] {
  return [m.config, ...m.layers]
}

/**
 * Download one blob into the store unless it is already cached. Interrupted transfers are retried with
 * backoff and resumed from the bytes already on disk (HTTP Range); the digest is verified before commit.
 */
export async function fetchBlob(
  client: RegistryClient,
  repo: string,
  d: { digest: string; size: number },
  store: BlobStore,
  opts: { signal: AbortSignal; progress?: Progress; retry?: Partial<RetryPolicy> }
): Promise<void> {
  const progress = opts.progress ?? { add: () => undefined }
  await store.exclusive(d.digest, async () => {
    if (store.has(d.digest, d.size)) {
      progress.add(d.size)
      return
    }
    const blob = await store.resumable(d.digest)
    // Progress reported so far for this blob; reconciled with what is really on disk after each attempt.
    let reported = blob.offset
    progress.add(blob.offset)
    const sync = () => {
      progress.add(blob.offset - reported)
      reported = blob.offset
    }
    await withRetry(
      async () => {
        if (d.size > 0 && blob.offset >= d.size) return // complete on disk already; just verify
        const res = await client.getBlobStream(repo, d.digest, opts.signal, blob.offset)
        if (res.offset !== blob.offset) blob.reset() // server ignored Range: start over
        sync()
        try {
          await blob.append(res.stream, (n) => {
            reported += n
            progress.add(n)
          })
        } finally {
          sync()
        }
      },
      { ...DEFAULT_RETRY, ...opts.retry },
      opts.signal
    )
    try {
      blob.commit()
    } catch (err) {
      progress.add(-reported)
      throw err
    }
  })
}

/** Download every blob of a manifest into the store (skipping ones already cached). */
export async function downloadBlobs(
  client: RegistryClient,
  repo: string,
  manifest: ImageManifest,
  store: BlobStore,
  opts: { concurrency: number; signal: AbortSignal; progress: Progress; retry?: Partial<RetryPolicy> }
): Promise<void> {
  const unique = [...new Map(blobsOf(manifest).map((d) => [d.digest, d])).values()]
  await mapLimit(unique, opts.concurrency, async (d) => {
    opts.signal.throwIfAborted()
    await fetchBlob(client, repo, d, store, opts)
  })
}

export interface PushableImage {
  manifestBytes: Buffer
  mediaType: string
  manifest: ImageManifest
  open(digest: string): Readable | Promise<Readable>
}

export function fileSource(resolve: (digest: string) => { path: string } | undefined) {
  return (digest: string): Readable => {
    const b = resolve(digest)
    if (!b) throw new Error(`Blob ${digest} missing from archive`)
    return createReadStream(b.path)
  }
}

/** Upload blobs and the manifest. `ref` may be a tag or (for index children) the manifest digest. */
export async function pushImage(
  client: RegistryClient,
  repo: string,
  ref: string,
  img: PushableImage,
  opts: { concurrency: number; signal: AbortSignal; progress: Progress; mountFrom?: string }
): Promise<string> {
  const unique = [...new Map(blobsOf(img.manifest).map((d) => [d.digest, d])).values()]
  await mapLimit(unique, opts.concurrency, async (d) => {
    opts.signal.throwIfAborted()
    let done = 0
    try {
      await client.uploadBlob(repo, d.digest, d.size, () => img.open(d.digest), {
        signal: opts.signal,
        mountFrom: opts.mountFrom,
        onProgress: (n) => {
          done += n
          opts.progress.add(n)
        }
      })
    } catch (err) {
      opts.progress.add(-done)
      throw err
    }
  })
  return client.putManifest(repo, ref, img.manifestBytes, img.mediaType, opts.signal)
}
