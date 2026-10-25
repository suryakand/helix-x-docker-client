// Image tarballs.
//
// Writer: produces a combined OCI image layout + Docker `manifest.json` archive — the same shape that
// `docker save` produces since Docker 25 — so it can be read by `docker load` (classic and containerd
// image stores), podman, skopeo, crane and other OCI tools.
//
// Reader: accepts that format, plain OCI layouts and the legacy docker-archive format
// (<id>/layer.tar + <config>.json), optionally gzip compressed.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import * as tar from 'tar-stream'
import {
  MT,
  isIndexMediaType,
  type ImageIndex,
  type ImageManifest,
  type ManifestDescriptor
} from '../registry/media'
import type { BlobStore } from './blob-store'
import { digestHex } from './blob-store'

export interface ArchiveImage {
  manifestBytes: Buffer
  manifestMediaType: string
  manifestDigest: string
  manifest: ImageManifest
  /** Full references, e.g. registry.example.com/team/app:1.0 */
  repoTags: string[]
  platform?: { os: string; architecture: string; variant?: string }
}

function sha256(data: Buffer | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/** Build the archive as a stream; blobs are read from the store while the tar is written. */
export function createImageArchive(
  images: ArchiveImage[],
  store: BlobStore,
  onProgress?: (n: number) => void
): Readable {
  const pack = tar.pack()
  const run = async () => {
    const written = new Set<string>()
    const addBuffer = (name: string, data: Buffer) =>
      new Promise<void>((resolve, reject) =>
        pack.entry({ name, size: data.length, mode: 0o644 }, data, (e) => (e ? reject(e) : resolve()))
      )
    const addBlob = async (d: { digest: string; size: number }) => {
      if (written.has(d.digest)) return
      written.add(d.digest)
      const name = `blobs/sha256/${digestHex(d.digest)}`
      const size = statSync(store.path(d.digest)).size
      await new Promise<void>((resolve, reject) => {
        const entry = pack.entry({ name, size, mode: 0o644 }, (e) => (e ? reject(e) : resolve()))
        const src = store.open(d.digest)
        src.on('data', (c: Buffer) => onProgress?.(c.length))
        src.on('error', reject)
        src.pipe(entry)
      })
    }

    await addBuffer('oci-layout', Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' })))
    const indexManifests: ManifestDescriptor[] = []
    const dockerManifest: { Config: string; RepoTags: string[]; Layers: string[] }[] = []
    for (const img of images) {
      await addBlob({ digest: img.manifest.config.digest, size: img.manifest.config.size })
      for (const l of img.manifest.layers) await addBlob(l)
      if (!written.has(img.manifestDigest)) {
        written.add(img.manifestDigest)
        await addBuffer(`blobs/sha256/${digestHex(img.manifestDigest)}`, img.manifestBytes)
      }
      const tags = img.repoTags.length ? img.repoTags : [undefined]
      for (const ref of tags) {
        indexManifests.push({
          mediaType: img.manifestMediaType,
          digest: img.manifestDigest,
          size: img.manifestBytes.length,
          ...(img.platform ? { platform: img.platform } : {}),
          ...(ref
            ? {
                annotations: {
                  'io.containerd.image.name': ref,
                  'org.opencontainers.image.ref.name': ref.slice(ref.lastIndexOf(':') + 1)
                }
              }
            : {})
        })
      }
      dockerManifest.push({
        Config: `blobs/sha256/${digestHex(img.manifest.config.digest)}`,
        RepoTags: img.repoTags,
        Layers: img.manifest.layers.map((l) => `blobs/sha256/${digestHex(l.digest)}`)
      })
    }
    const index: ImageIndex = { schemaVersion: 2, mediaType: MT.OCI_INDEX, manifests: indexManifests }
    await addBuffer('index.json', Buffer.from(JSON.stringify(index)))
    await addBuffer('manifest.json', Buffer.from(JSON.stringify(dockerManifest)))
    pack.finalize()
  }
  run().catch((err) => pack.destroy(err))
  // tar-stream uses streamx; expose a regular Node stream to callers (fetch bodies, pipeline).
  return Readable.from(pack as AsyncIterable<Buffer>, { objectMode: false })
}

export async function writeImageArchive(
  path: string,
  images: ArchiveImage[],
  store: BlobStore,
  onProgress?: (n: number) => void
) {
  mkdirSync(dirname(path), { recursive: true })
  await pipeline(createImageArchive(images, store, onProgress), createWriteStream(path))
}

// ------------------------------------------------------------------ reader

export interface ArchiveBlob {
  digest: string
  size: number
  path: string
}

export interface ReadImage {
  kind: 'manifest'
  manifestBytes: Buffer
  mediaType: string
  digest: string
  manifest: ImageManifest
  repoTags: string[]
  platform?: { os: string; architecture: string; variant?: string }
}

export interface ReadIndex {
  kind: 'index'
  indexBytes: Buffer
  mediaType: string
  digest: string
  /** Child manifests whose blobs are all present in the archive. */
  children: ReadImage[]
  /** True when every child of the index is present (so the index itself can be pushed). */
  complete: boolean
  repoTags: string[]
}

export interface ReadArchive {
  dir: string
  entries: (ReadImage | ReadIndex)[]
  blob(digest: string): ArchiveBlob | undefined
}

async function isGzip(path: string): Promise<boolean> {
  const fh = await openFile(path, 'r')
  try {
    const buf = Buffer.alloc(2)
    await fh.read(buf, 0, 2, 0)
    return buf[0] === 0x1f && buf[1] === 0x8b
  } finally {
    await fh.close()
  }
}

/** Extract a tar into `dir`, refusing entries that would escape it. */
export async function extractTar(source: Readable, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const root = normalize(dir + sep)
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    const target = normalize(join(dir, header.name))
    if (!target.startsWith(root) || header.type === 'symlink' || header.type === 'link') {
      stream.resume()
      stream.on('end', next)
      return
    }
    if (header.type === 'directory') {
      mkdirSync(target, { recursive: true })
      stream.resume()
      stream.on('end', next)
      return
    }
    if (header.type !== 'file' && header.type !== 'contiguous-file') {
      stream.resume()
      stream.on('end', next)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    pipeline(stream, createWriteStream(target)).then(() => next(), next)
  })
  await pipeline(source, extract)
}

export async function extractArchiveFile(
  path: string,
  dir: string,
  onProgress?: (n: number) => void
): Promise<void> {
  const gz = await isGzip(path)
  const src = createReadStream(path)
  if (onProgress) src.on('data', (c) => onProgress((c as Buffer).length))
  await extractTar(gz ? src.pipe(createGunzip()) : src, dir)
}

async function fileDigest(path: string): Promise<{ digest: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    size += (chunk as Buffer).length
  }
  return { digest: `sha256:${hash.digest('hex')}`, size }
}

async function looksGzipped(path: string): Promise<boolean> {
  return statSync(path).size >= 2 && (await isGzip(path))
}

/** Parse an extracted archive directory. */
export async function readArchiveDir(dir: string): Promise<ReadArchive> {
  const blobs = new Map<string, ArchiveBlob>()
  const ociBlob = (digest: string): ArchiveBlob | undefined => {
    const known = blobs.get(digest)
    if (known) return known
    let hex: string
    try {
      hex = digestHex(digest)
    } catch {
      return undefined
    }
    const p = join(dir, 'blobs', 'sha256', hex)
    if (!existsSync(p)) return undefined
    const b = { digest, size: statSync(p).size, path: p }
    blobs.set(digest, b)
    return b
  }

  const entries: (ReadImage | ReadIndex)[] = []
  const indexPath = join(dir, 'index.json')
  const dockerManifestPath = join(dir, 'manifest.json')
  const dockerManifest = existsSync(dockerManifestPath)
    ? (JSON.parse(readFileSync(dockerManifestPath, 'utf8')) as {
        Config: string
        RepoTags?: string[] | null
        Layers: string[]
      }[])
    : undefined

  const readImage = (desc: ManifestDescriptor, repoTags: string[]): ReadImage | undefined => {
    const b = ociBlob(desc.digest)
    if (!b) return undefined
    const bytes = readFileSync(b.path)
    const manifest = JSON.parse(bytes.toString('utf8')) as ImageManifest
    const all = [manifest.config, ...manifest.layers]
    if (!all.every((d) => ociBlob(d.digest))) return undefined
    return {
      kind: 'manifest',
      manifestBytes: bytes,
      mediaType: manifest.mediaType ?? desc.mediaType,
      digest: desc.digest,
      manifest,
      repoTags,
      platform: desc.platform
    }
  }

  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as ImageIndex
    for (const desc of index.manifests ?? []) {
      const name = desc.annotations?.['io.containerd.image.name']
      const refName = desc.annotations?.['org.opencontainers.image.ref.name']
      const repoTags = name ? [name] : refName && refName.includes(':') ? [refName] : []
      if (isIndexMediaType(desc.mediaType)) {
        const b = ociBlob(desc.digest)
        if (!b) continue
        const bytes = readFileSync(b.path)
        const child = JSON.parse(bytes.toString('utf8')) as ImageIndex
        const children = child.manifests
          .filter((m) => !isIndexMediaType(m.mediaType))
          .map((m) => readImage(m, repoTags))
          .filter((x): x is ReadImage => !!x)
        if (!children.length) continue
        entries.push({
          kind: 'index',
          indexBytes: bytes,
          mediaType: child.mediaType ?? desc.mediaType,
          digest: desc.digest,
          children,
          complete: children.length === child.manifests.length,
          repoTags
        })
      } else {
        const img = readImage(desc, repoTags)
        if (img) entries.push(img)
      }
    }
  }

  // Legacy docker-archive (or index.json entries were unusable).
  if (!entries.length && dockerManifest) {
    for (const item of dockerManifest) {
      const configPath = join(dir, item.Config)
      const configBytes = readFileSync(configPath)
      const configDigest = sha256(configBytes)
      blobs.set(configDigest, { digest: configDigest, size: configBytes.length, path: configPath })
      const layers: ManifestDescriptor[] = []
      for (const l of item.Layers) {
        const p = join(dir, l)
        const { digest, size } = await fileDigest(p)
        blobs.set(digest, { digest, size, path: p })
        layers.push({ mediaType: (await looksGzipped(p)) ? MT.OCI_LAYER_GZIP : MT.OCI_LAYER, digest, size })
      }
      const cfg = JSON.parse(configBytes.toString('utf8')) as {
        os?: string
        architecture?: string
        variant?: string
      }
      const manifest: ImageManifest = {
        schemaVersion: 2,
        mediaType: MT.OCI_MANIFEST,
        config: { mediaType: MT.OCI_CONFIG, digest: configDigest, size: configBytes.length },
        layers
      }
      const manifestBytes = Buffer.from(JSON.stringify(manifest))
      entries.push({
        kind: 'manifest',
        manifestBytes,
        mediaType: MT.OCI_MANIFEST,
        digest: sha256(manifestBytes),
        manifest,
        repoTags: item.RepoTags ?? [],
        platform:
          cfg.os && cfg.architecture
            ? { os: cfg.os, architecture: cfg.architecture, variant: cfg.variant }
            : undefined
      })
    }
  }

  // Docker's index.json may lack names; take them from manifest.json when it lists the same config.
  if (dockerManifest) {
    for (const e of entries) {
      if (e.kind !== 'manifest' || e.repoTags.length) continue
      const match = dockerManifest.find((d) => d.Config.endsWith(digestHex(e.manifest.config.digest)))
      if (match?.RepoTags) e.repoTags = match.RepoTags
    }
  }

  if (!entries.length)
    throw new Error('No images found in archive (expected an OCI layout or docker save archive)')
  return { dir, entries, blob: (d) => blobs.get(d) ?? ociBlob(d) }
}
