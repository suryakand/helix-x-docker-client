import type { DockerStatus, DockerStorageInfo, LocalImage } from '@helix/shared/types'
import { JsonFile } from '../store/json-file'
import { resolveEndpoint } from './endpoint'
import { DockerEngine, DockerEngineError, type EngineInfo } from './engine'
import { buildStorageInfo } from './storage'

interface LoadedRecord {
  /** Image references loaded into Docker by this app (used for the "pulled via Helix-X" filter). */
  refs: string[]
}

export class DockerService {
  private engine: DockerEngine | undefined
  private engineKey = ''
  private last: DockerStatus | undefined
  private readonly loaded: JsonFile<LoadedRecord>

  constructor(
    private readonly hostOverride: () => string,
    loadedPath: string,
    private readonly onStatus: (s: DockerStatus) => void
  ) {
    this.loaded = new JsonFile(loadedPath, () => ({ refs: [] }))
  }

  /** Engine for the currently configured endpoint (recreated when settings change). */
  current(): DockerEngine {
    const ep = resolveEndpoint(this.hostOverride())
    const key = `${ep.source}|${ep.uri}`
    if (!this.engine || key !== this.engineKey) {
      this.engine?.close().catch(() => undefined)
      this.engine = new DockerEngine(ep)
      this.engineKey = key
    }
    return this.engine
  }

  async status(): Promise<DockerStatus> {
    let status: DockerStatus
    let engine: DockerEngine | undefined
    try {
      engine = this.current()
      const ep = engine.endpoint
      await engine.ping()
      const v = await engine.version()
      status = {
        state: 'connected',
        endpoint: ep.uri,
        endpointSource: ep.source,
        contextName: ep.contextName,
        version: v.Version,
        apiVersion: v.ApiVersion,
        os: v.Os,
        arch: v.Arch
      }
    } catch (err) {
      const ep = engine?.endpoint ?? resolveEndpoint(this.hostOverride())
      const e = err as DockerEngineError
      status = {
        state:
          e.code === 'NOT_FOUND' || ep.source === 'none'
            ? 'not-found'
            : e.code === 'NOT_RUNNING'
              ? 'not-running'
              : 'error',
        endpoint: ep.uri,
        endpointSource: ep.source,
        contextName: ep.contextName,
        message: e.message
      }
    }
    if (JSON.stringify(status) !== JSON.stringify(this.last)) {
      this.last = status
      this.onStatus(status)
    }
    return status
  }

  async storageInfo(): Promise<DockerStorageInfo> {
    const status = await this.status()
    let info: EngineInfo | undefined
    let images: { count: number; size: number } | undefined
    if (status.state === 'connected') {
      const engine = this.current()
      info = await engine.info().catch(() => undefined)
      const list = await engine.listImages().catch(() => undefined)
      if (list) images = { count: list.length, size: list.reduce((a, i) => a + (i.Size ?? 0), 0) }
    }
    return buildStorageInfo(status, info, images)
  }

  async listImages(): Promise<LocalImage[]> {
    const refs = new Set(this.loaded.read().refs)
    const list = await this.current().listImages()
    return list
      .map((i) => {
        const repoTags = (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>')
        return {
          id: i.Id,
          repoTags,
          repoDigests: i.RepoDigests ?? [],
          created: i.Created,
          size: i.Size,
          labels: i.Labels ?? {},
          pulledByApp: repoTags.some((t) => refs.has(t)) || refs.has(i.Id)
        }
      })
      .sort((a, b) => b.created - a.created)
  }

  removeImage(id: string, force: boolean): Promise<void> {
    return this.current().removeImage(id, force)
  }

  rememberLoaded(refs: string[]): void {
    this.loaded.update((r) => ({ refs: [...new Set([...refs, ...r.refs])].slice(0, 5000) }))
  }

  dispose(): void {
    this.engine?.close().catch(() => undefined)
  }
}
