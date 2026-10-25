import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as tar from 'tar-stream'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { BlobStore, DigestMismatchError } from '../../src/transfer/blob-store'
import { extractArchiveFile, readArchiveDir, writeImageArchive } from '../../src/transfer/archive'
import { MT, type ImageManifest } from '../../src/registry/media'

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`

describe('image archives', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'archive-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('blob store verifies digests', async () => {
    const store = new BlobStore(join(dir, 'store'))
    const data = Buffer.from('hello')
    await store.put(sha(data), Readable.from([data]))
    expect(store.has(sha(data), data.length)).toBe(true)
    await expect(store.put(sha(Buffer.from('x')), Readable.from([data]))).rejects.toBeInstanceOf(
      DigestMismatchError
    )
    expect(store.stats().blobs).toBe(1)
  })

  it('writes an OCI + docker archive and reads it back', async () => {
    const store = new BlobStore(join(dir, 'store'))
    const layer = gzipSync(Buffer.from('layer-content'))
    const config = Buffer.from(
      JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } })
    )
    await store.putBuffer(sha(layer), layer)
    await store.putBuffer(sha(config), config)
    const manifest: ImageManifest = {
      schemaVersion: 2,
      mediaType: MT.OCI_MANIFEST,
      config: { mediaType: MT.OCI_CONFIG, digest: sha(config), size: config.length },
      layers: [{ mediaType: MT.OCI_LAYER_GZIP, digest: sha(layer), size: layer.length }]
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    const file = join(dir, 'img.tar')
    let written = 0
    await writeImageArchive(
      file,
      [
        {
          manifest,
          manifestBytes,
          manifestDigest: sha(manifestBytes),
          manifestMediaType: MT.OCI_MANIFEST,
          repoTags: ['reg.example.com/team/app:1.0'],
          platform: { os: 'linux', architecture: 'amd64' }
        }
      ],
      store,
      (n) => (written += n)
    )
    expect(written).toBe(layer.length + config.length)

    const out = join(dir, 'out')
    await extractArchiveFile(file, out)
    const archive = await readArchiveDir(out)
    expect(archive.entries).toHaveLength(1)
    const e = archive.entries[0]
    expect(e.kind).toBe('manifest')
    if (e.kind !== 'manifest') return
    expect(e.digest).toBe(sha(manifestBytes))
    expect(e.repoTags).toEqual(['reg.example.com/team/app:1.0'])
    expect(archive.blob(sha(layer))?.size).toBe(layer.length)
  })

  it('reads a legacy docker-archive (layer.tar + config json)', async () => {
    const src = join(dir, 'legacy')
    mkdirSync(join(src, 'abc'), { recursive: true })
    const layer = Buffer.from('plain tar bytes')
    const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'arm64' }))
    writeFileSync(join(src, 'abc', 'layer.tar'), layer)
    writeFileSync(join(src, 'cfg.json'), config)
    writeFileSync(
      join(src, 'manifest.json'),
      JSON.stringify([{ Config: 'cfg.json', RepoTags: ['app:dev'], Layers: ['abc/layer.tar'] }])
    )
    const archive = await readArchiveDir(src)
    const e = archive.entries[0]
    if (e.kind !== 'manifest') throw new Error('expected manifest')
    expect(e.repoTags).toEqual(['app:dev'])
    expect(e.platform).toEqual({ os: 'linux', architecture: 'arm64', variant: undefined })
    expect(e.manifest.layers[0]).toMatchObject({
      digest: sha(layer),
      size: layer.length,
      mediaType: MT.OCI_LAYER
    })
    expect(e.manifest.config.digest).toBe(sha(config))
  })

  it('refuses path traversal entries when extracting', async () => {
    const pack = tar.pack()
    pack.entry({ name: '../evil.txt' }, 'x')
    pack.entry({ name: 'ok.txt' }, 'y')
    pack.finalize()
    const file = join(dir, 'evil.tar')
    await pipeline(pack as unknown as Readable, createWriteStream(file))
    const out = join(dir, 'x', 'out')
    await extractArchiveFile(file, out)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, 'x', 'evil.txt'))).toBe(false)
    expect(existsSync(join(out, 'ok.txt'))).toBe(true)
  })
})
