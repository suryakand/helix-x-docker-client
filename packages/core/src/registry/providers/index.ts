// Provider specific behaviour: how credentials become registry Basic credentials, and how repositories
// are listed (many SaaS registries disable /v2/_catalog and expose their own REST API instead).
import { fetch, type Dispatcher } from 'undici'
import type { Page, RegistryConfig, RegistryCredentials, TagSummary } from '@helix/shared/types'
import type { BasicCredentials } from '../auth'
import { parseNextLink } from '../auth'
import type { RegistryClient } from '../client'
import { errorFromResponse, networkError, RegistryError } from '../errors'
import { registryHost, USER_AGENT } from '../http'

export interface ProviderContext {
  config: RegistryConfig
  secrets: RegistryCredentials
  client: RegistryClient
  dispatcher: Dispatcher
  pageSize: number
}

// ------------------------------------------------------------------ credentials

const ecrTokenCache = new Map<string, { creds: BasicCredentials; expiresAt: number }>()

export async function resolveCredentials(
  config: RegistryConfig,
  secrets: RegistryCredentials
): Promise<BasicCredentials | null> {
  switch (config.type) {
    case 'ecr':
      return ecrCredentials(config, secrets)
    case 'gcr': {
      if (secrets.serviceAccountJson?.trim())
        return { username: '_json_key', password: secrets.serviceAccountJson.trim() }
      if (secrets.accessToken?.trim())
        return { username: 'oauth2accesstoken', password: secrets.accessToken.trim() }
      return null
    }
    default:
      if (secrets.username || secrets.password)
        return { username: secrets.username ?? '', password: secrets.password ?? '' }
      return null
  }
}

export function ecrRegion(config: RegistryConfig): string {
  if (config.region) return config.region
  const m = /\.dkr\.ecr(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/.exec(config.url)
  if (!m) throw new RegistryError('Set the AWS region for this ECR registry', 'PROTOCOL')
  return m[1]
}

function ecrAccountId(config: RegistryConfig): string | undefined {
  return /^(?:https?:\/\/)?(\d{12})\.dkr\.ecr/.exec(config.url)?.[1]
}

async function ecrClient(config: RegistryConfig, secrets: RegistryCredentials) {
  if (!secrets.accessKeyId || !secrets.secretAccessKey) {
    throw new RegistryError('AWS access key ID and secret access key are required', 'UNAUTHORIZED')
  }
  const { ECRClient } = await import('@aws-sdk/client-ecr')
  return new ECRClient({
    region: ecrRegion(config),
    credentials: {
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
      sessionToken: secrets.sessionToken || undefined
    }
  })
}

async function ecrCredentials(
  config: RegistryConfig,
  secrets: RegistryCredentials
): Promise<BasicCredentials> {
  const cacheKey = `${config.id}|${secrets.accessKeyId}`
  const cached = ecrTokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.creds
  const { GetAuthorizationTokenCommand } = await import('@aws-sdk/client-ecr')
  const client = await ecrClient(config, secrets)
  try {
    const out = await client.send(new GetAuthorizationTokenCommand({}))
    const data = out.authorizationData?.[0]
    if (!data?.authorizationToken)
      throw new RegistryError('ECR returned no authorization token', 'UNAUTHORIZED')
    const [username, password] = Buffer.from(data.authorizationToken, 'base64').toString('utf8').split(':')
    const creds = { username, password }
    const expiresAt = (data.expiresAt?.getTime() ?? Date.now() + 11 * 3600_000) - 5 * 60_000
    ecrTokenCache.set(cacheKey, { creds, expiresAt })
    return creds
  } catch (err) {
    if (err instanceof RegistryError) throw err
    throw new RegistryError(`AWS: ${(err as Error).message}`, 'UNAUTHORIZED')
  } finally {
    client.destroy()
  }
}

export function clearProviderCaches(registryId: string): void {
  for (const k of ecrTokenCache.keys()) if (k.startsWith(`${registryId}|`)) ecrTokenCache.delete(k)
}

// ------------------------------------------------------------------ repository naming

/** Docker Hub official images live under library/. */
export function normalizeRepo(config: RegistryConfig, repo: string): string {
  const r = repo.trim().replace(/^\/+|\/+$/g, '')
  if (config.type === 'dockerhub' && !r.includes('/')) return `library/${r}`
  return r
}

/** Image reference as you would pass it to `docker pull`. */
export function pullReference(config: RegistryConfig, repo: string, ref: string): string {
  const sep = ref.startsWith('sha256:') ? '@' : ':'
  if (config.type === 'dockerhub') return `${repo.replace(/^library\//, '')}${sep}${ref}`
  return `${registryHost(config.url)}/${repo}${sep}${ref}`
}

// ------------------------------------------------------------------ listing

export async function listRepositories(ctx: ProviderContext, cursor?: string): Promise<Page<string>> {
  switch (ctx.config.type) {
    case 'dockerhub':
      return listDockerHub(ctx, cursor)
    case 'harbor':
      return withCatalogFallback(ctx, cursor, () => listHarbor(ctx, cursor))
    case 'ghcr':
      return listGhcr(ctx, cursor)
    case 'gitlab':
      return listGitLab(ctx, cursor)
    case 'ecr':
      return listEcr(ctx, cursor)
    default:
      return listCatalog(ctx, cursor)
  }
}

async function listCatalog(ctx: ProviderContext, cursor?: string): Promise<Page<string>> {
  try {
    const page = await ctx.client.catalog(cursor, ctx.pageSize)
    const prefix = ctx.config.namespace?.trim()
    const items = prefix ? page.items.filter((r) => r.startsWith(prefix)) : page.items
    return { items, next: page.next }
  } catch (err) {
    if (
      err instanceof RegistryError &&
      ['UNAUTHORIZED', 'DENIED', 'NOT_FOUND', 'UNSUPPORTED'].includes(err.code)
    ) {
      return {
        items: [],
        listingUnsupported: true,
        message: `This registry does not allow listing repositories (${err.message}). Open a repository by name instead.`
      }
    }
    throw err
  }
}

async function withCatalogFallback(
  ctx: ProviderContext,
  cursor: string | undefined,
  fn: () => Promise<Page<string>>
) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RegistryError && err.code === 'NETWORK') throw err
    return listCatalog(ctx, cursor?.startsWith('/v2/') ? cursor : undefined)
  }
}

async function apiGet(ctx: ProviderContext, url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      dispatcher: ctx.dispatcher
    })
    return res
  } catch (err) {
    throw networkError(err, url)
  }
}

function basicAuth(s: RegistryCredentials): Record<string, string> {
  return s.username || s.password
    ? { Authorization: `Basic ${Buffer.from(`${s.username ?? ''}:${s.password ?? ''}`).toString('base64')}` }
    : {}
}

// Docker Hub ------------------------------------------------------------

const hubJwtCache = new Map<string, { token: string; expiresAt: number }>()

async function dockerHubJwt(ctx: ProviderContext): Promise<string | undefined> {
  const { username, password } = ctx.secrets
  if (!username || !password) return undefined
  const key = `${username}:${password.slice(-6)}`
  const cached = hubJwtCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
      dispatcher: ctx.dispatcher
    }).catch((err) => {
      throw networkError(err, url)
    })
  let res = await post('https://hub.docker.com/v2/auth/token', { identifier: username, secret: password })
  let token: string | undefined
  if (res.ok) token = ((await res.json()) as { access_token?: string }).access_token
  if (!token) {
    res = await post('https://hub.docker.com/v2/users/login', { username, password })
    if (!res.ok) throw await errorFromResponse(res, 'Docker Hub login')
    token = ((await res.json()) as { token?: string }).token
  }
  if (!token) throw new RegistryError('Docker Hub login returned no token', 'UNAUTHORIZED')
  hubJwtCache.set(key, { token, expiresAt: Date.now() + 4 * 60_000 })
  return token
}

async function listDockerHub(ctx: ProviderContext, cursor?: string): Promise<Page<string>> {
  const ns = (ctx.config.namespace || ctx.secrets.username || '').trim().toLowerCase()
  if (!ns) {
    return {
      items: [],
      listingUnsupported: true,
      message: 'Set a namespace (user or organization) to list Docker Hub repositories.'
    }
  }
  const jwt = await dockerHubJwt(ctx)
  const url =
    cursor ??
    `https://hub.docker.com/v2/repositories/${encodeURIComponent(ns)}/?page_size=${Math.min(100, ctx.pageSize)}&ordering=last_updated`
  if (!url.startsWith('https://hub.docker.com/')) throw new RegistryError('Invalid cursor', 'PROTOCOL')
  const res = await apiGet(ctx, url, jwt ? { Authorization: `Bearer ${jwt}` } : {})
  if (!res.ok) throw await errorFromResponse(res, `Docker Hub repositories of ${ns}`)
  const body = (await res.json()) as { next?: string | null; results?: { name: string; namespace: string }[] }
  return {
    items: (body.results ?? []).map((r) => `${r.namespace ?? ns}/${r.name}`),
    next: body.next ?? undefined
  }
}

/**
 * Tag metadata from the Docker Hub REST API. Unlike GET /v2/<repo>/manifests/<tag>, this does not count
 * against Docker Hub pull rate limits. Returns undefined when the API cannot answer (caller falls back).
 */
export async function dockerHubTagSummary(
  ctx: ProviderContext,
  repo: string,
  tag: string
): Promise<Omit<TagSummary, 'tag'> | undefined> {
  try {
    const jwt = await dockerHubJwt(ctx)
    const url = `https://hub.docker.com/v2/repositories/${repo.split('/').map(encodeURIComponent).join('/')}/tags/${encodeURIComponent(tag)}`
    const res = await apiGet(ctx, url, jwt ? { Authorization: `Bearer ${jwt}` } : {})
    if (!res.ok) return undefined
    const body = (await res.json()) as {
      digest?: string
      media_type?: string
      full_size?: number
      last_updated?: string
      tag_last_pushed?: string
      images?: {
        os?: string
        architecture?: string
        variant?: string | null
        digest?: string
        size?: number
      }[]
    }
    if (!body.digest) return undefined
    const images = (body.images ?? []).filter((i) => i.os && i.architecture && i.os !== 'unknown')
    return {
      digest: body.digest,
      mediaType: body.media_type ?? '',
      size: body.full_size ?? images.reduce((a, i) => a + (i.size ?? 0), 0),
      created: body.tag_last_pushed ?? body.last_updated,
      platforms: images.map((i) => ({
        os: i.os!,
        architecture: i.architecture!,
        ...(i.variant ? { variant: i.variant } : {})
      }))
    }
  } catch {
    return undefined
  }
}

// Harbor ----------------------------------------------------------------

function harborApi(ctx: ProviderContext): string {
  return (ctx.config.apiUrl?.trim() || ctx.config.url).replace(/\/+$/, '')
}

async function listHarbor(ctx: ProviderContext, cursor?: string): Promise<Page<string>> {
  const page = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 1
  const size = Math.min(100, ctx.pageSize)
  const project = ctx.config.namespace?.trim()
  const base = harborApi(ctx)
  const url = project
    ? `${base}/api/v2.0/projects/${encodeURIComponent(project)}/repositories?page=${page}&page_size=${size}`
    : `${base}/api/v2.0/repositories?page=${page}&page_size=${size}`
  const res = await apiGet(ctx, url, basicAuth(ctx.secrets))
  if (!res.ok) throw await errorFromResponse(res, 'Harbor repositories')
  const body = (await res.json()) as { name: string }[]
  const total = Number(res.headers.get('x-total-count') ?? NaN)
  const hasMore = Number.isFinite(total) ? page * size < total : body.length === size
  return { items: body.map((r) => r.name), next: hasMore ? String(page + 1) : undefined }
}

// GitHub Container Registry --------------------------------------------

async function listGhcr(ctx: ProviderContext, cursor?: string): Promise<Page<string>> {
  const token = ctx.secrets.password
  if (!token)
    return {
      items: [],
      listingUnsupported: true,
      message: 'A personal access token is required to list GHCR packages.'
    }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const owner = ctx.config.namespace?.trim()
  const qs = `package_type=container&per_page=${Math.min(100, ctx.pageSize)}`
  let url = cursor
  if (!url) {
    if (owner) {
      url = `https://api.github.com/orgs/${encodeURIComponent(owner)}/packages?${qs}`
      const probe = await apiGet(ctx, url, headers)
      if (probe.status === 404)
        url = `https://api.github.com/users/${encodeURIComponent(owner)}/packages?${qs}`
      else return parseGhcr(probe, owner)
    } else {
      url = `https://api.github.com/user/packages?${qs}`
    }
  }
  if (!url.startsWith('https://api.github.com/')) throw new RegistryError('Invalid cursor', 'PROTOCOL')
  return parseGhcr(await apiGet(ctx, url, headers), owner)
}

async function parseGhcr(res: Awaited<ReturnType<typeof fetch>>, owner?: string): Promise<Page<string>> {
  if (!res.ok) throw await errorFromResponse(res, 'GitHub packages (token needs read:packages)')
  const body = (await res.json()) as { name: string; owner?: { login: string } }[]
  return {
    items: body.map((p) => `${(p.owner?.login ?? owner ?? '').toLowerCase()}/${p.name}`),
    next: parseNextLink(res.headers.get('link'))
  }
}

// GitLab ----------------------------------------------------------------

export function gitlabApiBase(config: RegistryConfig): string {
  if (config.apiUrl?.trim()) return config.apiUrl.trim().replace(/\/+$/, '')
  const host = registryHost(config.url)
  if (host === 'registry.gitlab.com') return 'https://gitlab.com'
  return `https://${host.replace(/^registry\./, '')}`
}

async function listGitLab(ctx: ProviderContext, cursor?: string): Promise<Page<string>> {
  const ns = ctx.config.namespace?.trim()
  if (!ns)
    return {
      items: [],
      listingUnsupported: true,
      message: 'Set a group or project path to list GitLab repositories.'
    }
  const token = ctx.secrets.password
  const headers: Record<string, string> = token ? { 'PRIVATE-TOKEN': token } : {}
  const page = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 1
  const base = gitlabApiBase(ctx.config)
  const qs = `per_page=${Math.min(100, ctx.pageSize)}&page=${page}`
  let res = await apiGet(
    ctx,
    `${base}/api/v4/groups/${encodeURIComponent(ns)}/registry/repositories?${qs}`,
    headers
  )
  if (res.status === 404) {
    res = await apiGet(
      ctx,
      `${base}/api/v4/projects/${encodeURIComponent(ns)}/registry/repositories?${qs}`,
      headers
    )
  }
  if (!res.ok)
    throw await errorFromResponse(res, `GitLab registry repositories of ${ns} (token needs read_api)`)
  const body = (await res.json()) as { path: string }[]
  const nextPage = res.headers.get('x-next-page')
  return { items: body.map((r) => r.path), next: nextPage ? nextPage : undefined }
}

// Amazon ECR ------------------------------------------------------------

async function listEcr(ctx: ProviderContext, cursor?: string): Promise<Page<string>> {
  const { DescribeRepositoriesCommand } = await import('@aws-sdk/client-ecr')
  const client = await ecrClient(ctx.config, ctx.secrets)
  try {
    const out = await client.send(
      new DescribeRepositoriesCommand({
        nextToken: cursor,
        maxResults: Math.min(1000, ctx.pageSize),
        registryId: ecrAccountId(ctx.config)
      })
    )
    return {
      items: (out.repositories ?? []).map((r) => r.repositoryName ?? '').filter(Boolean),
      next: out.nextToken
    }
  } catch (err) {
    throw new RegistryError(`AWS: ${(err as Error).message}`, 'DENIED')
  } finally {
    client.destroy()
  }
}
