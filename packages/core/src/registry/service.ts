import type { Dispatcher } from 'undici'
import type {
  ImageConfigSummary,
  ImageDetails,
  Page,
  Platform,
  RegistryConfig,
  RegistryCredentials,
  RegistryInput,
  Settings,
  TagSummary,
  TestConnectionResult
} from '@helix/shared/types'
import { RegistryClient } from './client'
import { RegistryError } from './errors'
import { createDispatcher, normalizeRegistryUrl } from './http'
import {
  isIndexMediaType,
  isSchema1,
  selectManifest,
  type ImageIndex,
  type ImageManifest,
  type ManifestDescriptor
} from './media'
import {
  clearProviderCaches,
  dockerHubTagSummary,
  listRepositories,
  normalizeRepo,
  pullReference,
  resolveCredentials
} from './providers'
import { Limiter } from '../util/limiter'
import type { RegistryStore } from '../store/registries'
import { mergeSecrets } from '../store/registries'

export interface ResolvedRegistry {
  config: RegistryConfig
  client: RegistryClient
  dispatcher: Dispatcher
  secrets: RegistryCredentials
}

export interface ResolvedImage {
  /** Top level manifest (index or image manifest) as stored in the registry. */
  top: { bytes: Buffer; mediaType: string; digest: string }
  index?: ImageIndex
  /** The platform specific image manifest. */
  manifest: ImageManifest
  manifestBytes: Buffer
  manifestMediaType: string
  manifestDigest: string
  platform?: Platform
}

const SUMMARY_CONCURRENCY = 4
const SUMMARY_CACHE_LIMIT = 5000

export class RegistryService {
  private cache = new Map<string, ResolvedRegistry>()
  /** Tag summaries by "<registryId>|<digest>" (insertion ordered for LRU eviction). */
  private summaries = new Map<string, Omit<TagSummary, 'tag'>>()
  private limiters = new Map<string, Limiter>()

  constructor(
    private readonly store: RegistryStore,
    private readonly settings: () => Settings,
    private readonly pageSize: () => number
  ) {}

  /** Drop cached clients (tokens, dispatchers) after configuration or settings changes. */
  invalidate(id?: string): void {
    if (id) {
      this.cache
        .get(id)
        ?.dispatcher.close()
        .catch(() => undefined)
      this.cache.delete(id)
      clearProviderCaches(id)
      return
    }
    for (const r of this.cache.values()) r.dispatcher.close().catch(() => undefined)
    this.cache.clear()
  }

  resolve(id: string): ResolvedRegistry {
    const hit = this.cache.get(id)
    if (hit) return hit
    const config = this.store.get(id)
    const resolved = this.build(config, this.store.secrets(id))
    this.cache.set(id, resolved)
    return resolved
  }

  private build(config: RegistryConfig, secrets: RegistryCredentials): ResolvedRegistry {
    const s = this.settings()
    const dispatcher = createDispatcher(config.tls, {
      timeoutMs: s.requestTimeoutSec * 1000,
      proxy: s.proxy,
      caFiles: s.caFiles
    })
    const client = new RegistryClient({
      baseUrl: normalizeRegistryUrl(config.url, config.tls.plainHttp),
      dispatcher,
      credentials: () => resolveCredentials(config, secrets)
    })
    return { config, client, dispatcher, secrets }
  }

  repo(id: string, repo: string): string {
    return normalizeRepo(this.resolve(id).config, repo)
  }

  async test(input: RegistryInput & { id?: string }): Promise<TestConnectionResult> {
    const now = new Date().toISOString()
    const config: RegistryConfig = {
      ...input.config,
      id: input.id ?? 'draft',
      isDefault: false,
      pinnedRepos: [],
      createdAt: now,
      updatedAt: now
    }
    const stored = input.id ? this.store.secrets(input.id) : {}
    const secrets = mergeSecrets(stored, input.credentials ?? {})
    if (input.id) clearProviderCaches(input.id)
    const started = Date.now()
    let resolved: ResolvedRegistry | undefined
    try {
      resolved = this.build(config, secrets)
      await resolved.client.ping()
      const latencyMs = Date.now() - started
      let canList = false
      let listMessage = ''
      try {
        const page = await listRepositories({ ...resolved, pageSize: 1 })
        canList = !page.listingUnsupported
        if (page.listingUnsupported)
          listMessage = ' Repository listing is not available; you can still open repositories by name.'
      } catch (err) {
        listMessage = ` Listing repositories failed: ${(err as Error).message}`
      }
      const auth = resolved.client.authKind
      return {
        ok: true,
        latencyMs,
        canList,
        auth: auth === 'bearer' || auth === 'basic' || auth === 'anonymous' ? auth : 'anonymous',
        message: `Connected to ${config.url} in ${latencyMs} ms.${listMessage}`
      }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        canList: false,
        auth: 'unknown',
        message: (err as Error).message
      }
    } finally {
      resolved?.dispatcher.close().catch(() => undefined)
    }
  }

  async listRepositories(id: string, cursor?: string): Promise<Page<string>> {
    const r = this.resolve(id)
    return listRepositories({ ...r, pageSize: this.pageSize() }, cursor)
  }

  async listTags(id: string, repo: string, cursor?: string): Promise<Page<string>> {
    const r = this.resolve(id)
    const page = await r.client.tags(normalizeRepo(r.config, repo), cursor, this.pageSize())
    return { items: page.items, next: page.next }
  }

  /** Resolve a reference to a single platform image manifest. */
  async resolveImage(
    id: string,
    repo: string,
    ref: string,
    platform?: Platform,
    signal?: AbortSignal
  ): Promise<ResolvedImage> {
    const r = this.resolve(id)
    const name = normalizeRepo(r.config, repo)
    const top = await r.client.getManifest(name, ref, signal)
    if (isSchema1(top.mediaType)) {
      throw new RegistryError('Docker schema 1 manifests are deprecated and not supported', 'UNSUPPORTED')
    }
    const parsed = JSON.parse(top.bytes.toString('utf8')) as ImageIndex | ImageManifest
    if (isIndexMediaType(top.mediaType) || 'manifests' in parsed) {
      const index = parsed as ImageIndex
      const chosen = selectManifest(index, platform)
      if (!chosen) {
        throw new RegistryError(
          `No manifest for platform ${platform ? `${platform.os}/${platform.architecture}` : ''} in ${name}:${ref}`,
          'NOT_FOUND'
        )
      }
      const child = await r.client.getManifest(name, chosen.digest, signal)
      return {
        top,
        index,
        manifest: JSON.parse(child.bytes.toString('utf8')) as ImageManifest,
        manifestBytes: child.bytes,
        manifestMediaType: child.mediaType || chosen.mediaType,
        manifestDigest: child.digest,
        platform: chosen.platform
      }
    }
    return {
      top,
      manifest: parsed as ImageManifest,
      manifestBytes: top.bytes,
      manifestMediaType: top.mediaType,
      manifestDigest: top.digest
    }
  }

  /**
   * Size / created / platforms for one tag, cheap enough to call for every visible row:
   * - a HEAD request resolves the digest (HEAD does not count against Docker Hub pull limits);
   * - summaries are cached by digest, which is immutable, so tags sharing a digest cost one HEAD each;
   * - Docker Hub metadata comes from its REST API instead of manifest GETs;
   * - at most 4 summaries per registry are resolved at once.
   */
  async tagSummary(id: string, repo: string, tag: string): Promise<TagSummary> {
    return this.limiter(id).run(async () => {
      const r = this.resolve(id)
      const name = normalizeRepo(r.config, repo)
      const head = await r.client.headManifest(name, tag).catch(() => null)
      const cached = head && this.summaries.get(`${id}|${head.digest}`)
      if (cached) return { ...cached, tag }

      let summary =
        r.config.type === 'dockerhub'
          ? await dockerHubTagSummary({ ...r, pageSize: 1 }, name, tag)
          : undefined
      summary ??= await this.summaryFromManifest(id, repo, tag)
      this.remember(id, summary.digest, summary)
      if (head && head.digest !== summary.digest) this.remember(id, head.digest, summary)
      return { ...summary, tag }
    })
  }

  private async summaryFromManifest(id: string, repo: string, tag: string): Promise<Omit<TagSummary, 'tag'>> {
    const r = this.resolve(id)
    const name = normalizeRepo(r.config, repo)
    const img = await this.resolveImage(id, repo, tag)
    let created: string | undefined
    try {
      const cfg = JSON.parse(
        (await r.client.getBlobBytes(name, img.manifest.config.digest)).toString('utf8')
      ) as {
        created?: string
      }
      created = cfg.created
    } catch {
      /* config is optional for the summary */
    }
    return {
      digest: img.top.digest,
      mediaType: img.top.mediaType,
      size: imageSize(img.manifest),
      created,
      platforms: platformsOf(img)
    }
  }

  private remember(id: string, digest: string, summary: Omit<TagSummary, 'tag'>): void {
    const key = `${id}|${digest}`
    this.summaries.delete(key)
    this.summaries.set(key, summary)
    if (this.summaries.size > SUMMARY_CACHE_LIMIT) this.summaries.delete(this.summaries.keys().next().value!)
  }

  private limiter(id: string): Limiter {
    let l = this.limiters.get(id)
    if (!l) this.limiters.set(id, (l = new Limiter(SUMMARY_CONCURRENCY)))
    return l
  }

  async imageDetails(id: string, repo: string, ref: string, platform?: Platform): Promise<ImageDetails> {
    const r = this.resolve(id)
    const name = normalizeRepo(r.config, repo)
    const img = await this.resolveImage(id, repo, ref, platform)
    const configBytes = await r.client.getBlobBytes(name, img.manifest.config.digest)
    return {
      registryId: id,
      repo: name,
      ref,
      digest: img.top.digest,
      mediaType: img.top.mediaType,
      isIndex: !!img.index,
      platforms: platformsOf(img),
      selectedPlatform: img.platform,
      manifestDigest: img.manifestDigest,
      config: summarizeConfig(configBytes),
      configDigest: img.manifest.config.digest,
      layers: img.manifest.layers.map(toDescriptor),
      totalSize: imageSize(img.manifest),
      rawManifest: pretty(img.manifestBytes),
      rawIndex: img.index ? pretty(img.top.bytes) : undefined,
      rawConfig: pretty(configBytes),
      pullCommand: `docker pull ${pullReference(r.config, name, ref)}`
    }
  }

  async deleteTag(id: string, repo: string, ref: string): Promise<void> {
    if (!this.settings().allowDeletes) throw new Error('Deleting is disabled in Settings')
    const r = this.resolve(id)
    const name = normalizeRepo(r.config, repo)
    let digest = ref
    if (!ref.startsWith('sha256:')) {
      const head = await r.client.headManifest(name, ref)
      digest = head?.digest ?? (await r.client.getManifest(name, ref)).digest
    }
    await r.client.deleteManifest(name, digest)
  }

  async retag(id: string, repo: string, ref: string, newTag: string): Promise<void> {
    const r = this.resolve(id)
    const name = normalizeRepo(r.config, repo)
    const m = await r.client.getManifest(name, ref)
    await r.client.putManifest(name, newTag, m.bytes, m.mediaType)
  }
}

function pretty(bytes: Buffer): string {
  try {
    return JSON.stringify(JSON.parse(bytes.toString('utf8')), null, 2)
  } catch {
    return bytes.toString('utf8')
  }
}

function toDescriptor(d: ManifestDescriptor) {
  return { mediaType: d.mediaType, digest: d.digest, size: d.size, annotations: d.annotations }
}

export function imageSize(m: ImageManifest): number {
  return (m.config?.size ?? 0) + (m.layers ?? []).reduce((a, l) => a + (l.size ?? 0), 0)
}

function platformsOf(img: ResolvedImage): Platform[] {
  if (!img.index) return img.platform ? [img.platform] : []
  return img.index.manifests
    .filter((m) => m.platform && !(m.platform.os === 'unknown' && m.platform.architecture === 'unknown'))
    .map((m) => ({
      os: m.platform!.os,
      architecture: m.platform!.architecture,
      variant: m.platform!.variant
    }))
}

interface RawConfig {
  created?: string
  author?: string
  architecture?: string
  os?: string
  variant?: string
  config?: {
    User?: string
    WorkingDir?: string
    Env?: string[] | null
    Entrypoint?: string[] | null
    Cmd?: string[] | null
    ExposedPorts?: Record<string, unknown> | null
    Volumes?: Record<string, unknown> | null
    Labels?: Record<string, string> | null
  }
  history?: { created?: string; created_by?: string; comment?: string; empty_layer?: boolean }[]
}

export function summarizeConfig(bytes: Buffer): ImageConfigSummary {
  let c: RawConfig = {}
  try {
    c = JSON.parse(bytes.toString('utf8')) as RawConfig
  } catch {
    /* non-image artifacts (Helm charts, signatures …) may carry other config types */
  }
  const cc = c.config ?? {}
  return {
    created: c.created,
    architecture: c.architecture,
    os: c.os,
    variant: c.variant,
    author: c.author,
    user: cc.User || undefined,
    workingDir: cc.WorkingDir || undefined,
    env: cc.Env ?? [],
    entrypoint: cc.Entrypoint ?? [],
    cmd: cc.Cmd ?? [],
    exposedPorts: Object.keys(cc.ExposedPorts ?? {}),
    volumes: Object.keys(cc.Volumes ?? {}),
    labels: cc.Labels ?? {},
    history: (c.history ?? []).map((h) => ({
      created: h.created,
      createdBy: h.created_by,
      comment: h.comment,
      emptyLayer: h.empty_layer
    }))
  }
}
