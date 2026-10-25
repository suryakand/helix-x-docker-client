// Background job queue for pull / export / import / push / copy / load operations.
import { randomUUID } from 'node:crypto'
import { createReadStream, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import type { Job, JobSpec, Platform, Preferences, Settings } from '@helix/shared/types'
import type { DockerService } from '../docker/service'
import {
  normalizeArch,
  parsePlatform,
  platformString,
  isIndexMediaType,
  type ImageIndex,
  type ImageManifest
} from '../registry/media'
import { normalizeRepo, pullReference } from '../registry/providers'
import type { RegistryService, ResolvedImage } from '../registry/service'
import { JsonFile } from '../store/json-file'
import {
  extractArchiveFile,
  extractTar,
  readArchiveDir,
  writeImageArchive,
  createImageArchive,
  type ReadImage
} from './archive'
import { BlobStore } from './blob-store'
import { blobsOf, downloadBlobs, fetchBlob, fileSource, pushImage, type Progress } from './operations'
import { imageSize } from '../registry/service'

export interface JobDeps {
  registries: RegistryService
  docker: DockerService
  settings: () => Settings
  preferences: () => Preferences
  cacheDir: string
  tmpDir: string
  historyPath: string
  emit: (job: Job) => void
  emitRemoved: (id: string) => void
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

interface Running {
  controller: AbortController
}

const HISTORY_LIMIT = 200

export class JobManager {
  private jobs: Job[]
  private running = new Map<string, Running>()
  private readonly history: JsonFile<{ jobs: Job[] }>
  private lastEmit = new Map<string, number>()

  constructor(private readonly d: JobDeps) {
    this.history = new JsonFile(d.historyPath, () => ({ jobs: [] }))
    // Anything that was in flight when the app quit is reported as interrupted.
    this.jobs = this.history.read().jobs.map((j) =>
      j.status === 'running' || j.status === 'queued'
        ? {
            ...j,
            status: 'failed',
            error: 'Interrupted (application was closed)',
            finishedAt: j.finishedAt ?? new Date().toISOString()
          }
        : j
    )
  }

  list(): Job[] {
    return [...this.jobs].reverse()
  }

  start(spec: JobSpec): Job {
    const job: Job = {
      id: randomUUID(),
      kind: spec.kind,
      title: this.title(spec),
      spec,
      status: 'queued',
      phase: 'Queued',
      bytesDone: 0,
      bytesTotal: 0,
      createdAt: new Date().toISOString()
    }
    this.jobs.push(job)
    this.trim()
    this.changed(job, true)
    this.pump()
    return job
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    if (job.status === 'queued') {
      this.finish(job, 'cancelled')
    } else {
      this.running.get(id)?.controller.abort()
    }
  }

  retry(id: string): Job {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) throw new Error('Job not found')
    return this.start(job.spec)
  }

  clearFinished(): void {
    const removed = this.jobs.filter((j) => j.status !== 'running' && j.status !== 'queued')
    this.jobs = this.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
    removed.forEach((j) => this.d.emitRemoved(j.id))
    this.persist()
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.controller.abort()
  }

  // ------------------------------------------------------------------ scheduling

  private pump(): void {
    const limit = this.d.settings().jobConcurrency
    for (const job of this.jobs) {
      if (this.running.size >= limit) break
      if (job.status !== 'queued') continue
      const controller = new AbortController()
      this.running.set(job.id, { controller })
      job.status = 'running'
      job.startedAt = new Date().toISOString()
      this.changed(job, true)
      this.execute(job, controller.signal)
        .then((result) => {
          job.result = result
          this.finish(job, 'done')
        })
        .catch((err: Error) => {
          if (controller.signal.aborted) {
            this.finish(job, 'cancelled')
          } else {
            job.error = err.message
            this.d.log('error', `Job ${job.title} failed: ${err.stack ?? err.message}`)
            this.finish(job, 'failed')
          }
        })
        .finally(() => {
          this.running.delete(job.id)
          this.pump()
        })
    }
  }

  private finish(job: Job, status: Job['status']): void {
    job.status = status
    job.finishedAt = new Date().toISOString()
    job.phase = status === 'done' ? 'Completed' : status === 'cancelled' ? 'Cancelled' : 'Failed'
    if (status === 'done') job.bytesDone = job.bytesTotal
    this.changed(job, true)
  }

  private changed(job: Job, force = false): void {
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(job.id) ?? 0) < 150) return
    this.lastEmit.set(job.id, now)
    this.d.emit({ ...job })
    if (force) this.persist()
  }

  private persist(): void {
    this.history.write({ jobs: this.jobs })
  }

  private trim(): void {
    while (this.jobs.length > HISTORY_LIMIT) {
      const idx = this.jobs.findIndex((j) => j.status !== 'running' && j.status !== 'queued')
      if (idx < 0) break
      this.d.emitRemoved(this.jobs[idx].id)
      this.jobs.splice(idx, 1)
    }
  }

  private phase(job: Job, phase: string, total?: number): Progress {
    job.phase = phase
    if (total !== undefined) {
      job.bytesTotal = total
      job.bytesDone = 0
    }
    this.changed(job, true)
    return {
      add: (n) => {
        job.bytesDone = Math.max(0, Math.min(job.bytesTotal || Number.MAX_SAFE_INTEGER, job.bytesDone + n))
        this.changed(job)
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private title(spec: JobSpec): string {
    const name = (r: { registryId: string; repo: string; ref: string }) => {
      let reg = r.registryId
      try {
        reg = this.d.registries.resolve(r.registryId).config.name
      } catch {
        /* registry may have been deleted */
      }
      return `${r.repo}${r.ref.startsWith('sha256:') ? '@' + r.ref.slice(0, 19) : ':' + r.ref} (${reg})`
    }
    switch (spec.kind) {
      case 'pull':
        return `Pull ${name(spec.source)} → Docker`
      case 'export':
        return `Export ${name(spec.source)} → ${spec.filePath}`
      case 'import':
        return `Import ${spec.filePath} → ${name(spec.target)}`
      case 'push':
        return `Push ${spec.localImage} → ${name(spec.target)}`
      case 'copy':
        return `Copy ${name(spec.source)} → ${name(spec.target)}`
      case 'load':
        return `Load ${spec.filePath} → Docker`
    }
  }

  /** Scratch / cache store for a job. The persistent cache is shared; otherwise a per-job temp dir. */
  private store(): { store: BlobStore; cleanup: () => void } {
    const s = this.d.settings()
    if (s.blobCache.enabled) {
      const store = new BlobStore(this.d.cacheDir, s.blobCache.maxSizeGb * 1024 ** 3)
      return { store, cleanup: () => store.prune() }
    }
    const store = new BlobStore(mkdtempSync(join(this.d.tmpDir, 'blobs-')))
    return { store, cleanup: () => store.destroy() }
  }

  private async defaultPlatform(): Promise<Platform | undefined> {
    const pref = this.d.preferences().defaultPlatform
    if (pref && pref !== 'auto') return parsePlatform(pref)
    const status = await this.d.docker.status()
    if (status.state === 'connected' && status.os && status.arch)
      return { os: status.os, ...normalizeArch(status.arch) }
    return { os: 'linux', ...normalizeArch(process.arch) }
  }

  private localName(registryId: string, repo: string, ref: string): string {
    const config = this.d.registries.resolve(registryId).config
    const name = normalizeRepo(config, repo)
    const tag = ref.startsWith('sha256:') ? `sha256-${ref.slice(7, 19)}` : ref
    const full = pullReference(config, name, tag)
    if (this.d.preferences().localTagStyle === 'short' && config.type !== 'dockerhub') return `${name}:${tag}`
    return full
  }

  private async resolveAndDownload(
    job: Job,
    source: { registryId: string; repo: string; ref: string },
    platform: Platform | undefined,
    signal: AbortSignal,
    store: BlobStore
  ) {
    this.phase(job, 'Resolving manifest')
    const img = await this.d.registries.resolveImage(
      source.registryId,
      source.repo,
      source.ref,
      platform,
      signal
    )
    const r = this.d.registries.resolve(source.registryId)
    const repo = normalizeRepo(r.config, source.repo)
    const progress = this.phase(
      job,
      `Downloading ${img.manifest.layers.length} layers${img.platform ? ` (${platformString(img.platform)})` : ''}`,
      imageSize(img.manifest)
    )
    await downloadBlobs(r.client, repo, img.manifest, store, {
      concurrency: this.d.settings().blobConcurrency,
      signal,
      progress
    })
    return img
  }

  // ------------------------------------------------------------------ job bodies

  private async execute(job: Job, signal: AbortSignal): Promise<string | undefined> {
    const spec = job.spec
    switch (spec.kind) {
      case 'pull':
        return this.runPull(job, spec, signal)
      case 'export':
        return this.runExport(job, spec, signal)
      case 'import':
        return this.runImport(job, spec, signal)
      case 'push':
        return this.runPush(job, spec, signal)
      case 'copy':
        return this.runCopy(job, spec, signal)
      case 'load':
        return this.runLoad(job, spec, signal)
    }
  }

  private async runPull(job: Job, spec: Extract<JobSpec, { kind: 'pull' }>, signal: AbortSignal) {
    const status = await this.d.docker.status()
    if (status.state !== 'connected')
      throw new Error(
        `Docker engine is not available: ${status.message ?? status.state}. Use Export to save a .tar instead.`
      )
    const { store, cleanup } = this.store()
    try {
      const img = await this.resolveAndDownload(
        job,
        spec.source,
        spec.platform ?? (await this.defaultPlatform()),
        signal,
        store
      )
      const name = this.localName(spec.source.registryId, spec.source.repo, spec.source.ref)
      const progress = this.phase(job, 'Loading into Docker', imageSize(img.manifest))
      const tarStream = createImageArchive([archiveImage(img, [name])], store, (n) => progress.add(n))
      await this.d.docker.current().loadImage(tarStream, signal)
      const refs = [name]
      if (spec.extraTag?.trim()) {
        const extra = spec.extraTag.trim()
        const idx = extra.lastIndexOf(':')
        const hasTag = idx > extra.lastIndexOf('/')
        await this.d.docker
          .current()
          .tagImage(name, hasTag ? extra.slice(0, idx) : extra, hasTag ? extra.slice(idx + 1) : 'latest')
        refs.push(hasTag ? extra : `${extra}:latest`)
      }
      this.d.docker.rememberLoaded(refs)
      return refs.join(', ')
    } finally {
      cleanup()
    }
  }

  private async runExport(job: Job, spec: Extract<JobSpec, { kind: 'export' }>, signal: AbortSignal) {
    const { store, cleanup } = this.store()
    try {
      const img = await this.resolveAndDownload(job, spec.source, spec.platform, signal, store)
      const name = this.localName(spec.source.registryId, spec.source.repo, spec.source.ref)
      const progress = this.phase(job, 'Writing archive', imageSize(img.manifest))
      const partial = `${spec.filePath}.partial`
      try {
        await writeImageArchive(partial, [archiveImage(img, [name])], store, (n) => progress.add(n))
        signal.throwIfAborted()
        renameSync(partial, spec.filePath)
      } catch (err) {
        rmSync(partial, { force: true })
        throw err
      }
      return spec.filePath
    } finally {
      cleanup()
    }
  }

  private async pushArchiveDir(
    job: Job,
    dir: string,
    target: { registryId: string; repo: string; ref: string },
    signal: AbortSignal,
    prefer?: string
  ) {
    this.phase(job, 'Reading archive')
    const archive = await readArchiveDir(dir)
    const entry =
      (prefer &&
        archive.entries.find((e) => e.repoTags.some((t) => t === prefer || t.endsWith(`/${prefer}`)))) ||
      archive.entries[0]
    const r = this.d.registries.resolve(target.registryId)
    const repo = normalizeRepo(r.config, target.repo)
    const concurrency = this.d.settings().blobConcurrency
    const open = fileSource(archive.blob)
    const children: ReadImage[] = entry.kind === 'index' ? entry.children : [entry]
    const total = children.reduce((a, c) => a + imageSize(c.manifest), 0)
    const progress = this.phase(job, `Uploading to ${r.config.name}`, total)

    if (entry.kind === 'index' && entry.complete) {
      for (const c of children) {
        await pushImage(
          r.client,
          repo,
          c.digest,
          { manifestBytes: c.manifestBytes, mediaType: c.mediaType, manifest: c.manifest, open },
          { concurrency, signal, progress }
        )
      }
      await r.client.putManifest(repo, target.ref, entry.indexBytes, entry.mediaType, signal)
    } else {
      const c = children[0]
      await pushImage(
        r.client,
        repo,
        target.ref,
        { manifestBytes: c.manifestBytes, mediaType: c.mediaType, manifest: c.manifest, open },
        { concurrency, signal, progress }
      )
    }
    return pullReference(r.config, repo, target.ref)
  }

  private async runImport(job: Job, spec: Extract<JobSpec, { kind: 'import' }>, signal: AbortSignal) {
    const dir = mkdtempSync(join(this.d.tmpDir, 'import-'))
    try {
      const progress = this.phase(job, 'Extracting archive', statSync(spec.filePath).size)
      await extractArchiveFile(spec.filePath, dir, (n) => progress.add(n))
      signal.throwIfAborted()
      return await this.pushArchiveDir(job, dir, spec.target, signal)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private async runPush(job: Job, spec: Extract<JobSpec, { kind: 'push' }>, signal: AbortSignal) {
    const dir = mkdtempSync(join(this.d.tmpDir, 'push-'))
    try {
      const progress = this.phase(job, `Exporting ${spec.localImage} from Docker`, 0)
      const stream = await this.d.docker.current().saveImage(spec.localImage, signal)
      await extractTar(stream.pipe(counter((n) => progress.add(n))), dir)
      signal.throwIfAborted()
      return await this.pushArchiveDir(job, dir, spec.target, signal, spec.localImage)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private async runCopy(job: Job, spec: Extract<JobSpec, { kind: 'copy' }>, signal: AbortSignal) {
    const { store, cleanup } = this.store()
    try {
      const src = this.d.registries.resolve(spec.source.registryId)
      const dst = this.d.registries.resolve(spec.target.registryId)
      const srcRepo = normalizeRepo(src.config, spec.source.repo)
      const dstRepo = normalizeRepo(dst.config, spec.target.repo)
      const sameRegistry = src.client.baseUrl === dst.client.baseUrl
      const concurrency = this.d.settings().blobConcurrency
      this.phase(job, 'Resolving manifest')
      const top = await src.client.getManifest(srcRepo, spec.source.ref, signal)

      const multi = !!spec.allPlatforms && isIndexMediaType(top.mediaType)
      const images: { bytes: Buffer; mediaType: string; digest: string; manifest: ImageManifest }[] = []
      if (multi) {
        const index = JSON.parse(top.bytes.toString('utf8')) as ImageIndex
        for (const m of index.manifests) {
          const child = await src.client.getManifest(srcRepo, m.digest, signal)
          images.push({ ...child, manifest: JSON.parse(child.bytes.toString('utf8')) as ImageManifest })
        }
      } else {
        const img = await this.d.registries.resolveImage(
          spec.source.registryId,
          spec.source.repo,
          spec.source.ref,
          spec.platform,
          signal
        )
        images.push({
          bytes: img.manifestBytes,
          mediaType: img.manifestMediaType,
          digest: img.manifestDigest,
          manifest: img.manifest
        })
      }

      // Blobs are fetched from the source only when the target neither has them nor accepts a mount.
      const sizes = new Map(
        images.flatMap((i) => blobsOf(i.manifest).map((d) => [d.digest, d.size] as const))
      )
      const open = async (digest: string) => {
        await fetchBlob(src.client, srcRepo, { digest, size: sizes.get(digest) ?? -1 }, store, { signal })
        return store.open(digest)
      }
      const progress = this.phase(
        job,
        `Copying to ${dst.config.name}`,
        images.reduce((a, i) => a + imageSize(i.manifest), 0)
      )
      for (const i of images) {
        await pushImage(
          dst.client,
          dstRepo,
          multi ? i.digest : spec.target.ref,
          { manifestBytes: i.bytes, mediaType: i.mediaType, manifest: i.manifest, open },
          { concurrency, signal, progress, mountFrom: sameRegistry ? srcRepo : undefined }
        )
      }
      if (multi) await dst.client.putManifest(dstRepo, spec.target.ref, top.bytes, top.mediaType, signal)
      return pullReference(dst.config, dstRepo, spec.target.ref)
    } finally {
      cleanup()
    }
  }

  private async runLoad(job: Job, spec: Extract<JobSpec, { kind: 'load' }>, signal: AbortSignal) {
    const status = await this.d.docker.status()
    if (status.state !== 'connected')
      throw new Error(`Docker engine is not available: ${status.message ?? status.state}`)
    const progress = this.phase(job, 'Loading into Docker', statSync(spec.filePath).size)
    const loaded = await this.d.docker
      .current()
      .loadImage(createReadStream(spec.filePath).pipe(counter((n) => progress.add(n))), signal)
    this.d.docker.rememberLoaded(loaded)
    return loaded.join(', ') || 'Loaded'
  }
}

function archiveImage(img: ResolvedImage, repoTags: string[]) {
  return {
    manifestBytes: img.manifestBytes,
    manifestMediaType: img.manifestMediaType,
    manifestDigest: img.manifestDigest,
    manifest: img.manifest,
    repoTags,
    platform: img.platform
  }
}

function counter(onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      onBytes(chunk.length)
      cb(null, chunk)
    }
  })
}
