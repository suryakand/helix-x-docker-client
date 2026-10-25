// Minimal Docker Engine API client over a unix socket, Windows named pipe or TCP (optionally TLS).
import { Readable } from 'node:stream'
import { Agent, fetch, type Response } from 'undici'
import { endpointSocketPath, type DockerEndpoint } from './endpoint'

export interface EngineVersion {
  Version: string
  ApiVersion: string
  Os: string
  Arch: string
  Platform?: { Name?: string }
}

export interface EngineInfo {
  Name?: string
  OperatingSystem?: string
  OSType?: string
  Architecture?: string
  DockerRootDir?: string
  Driver?: string
  DriverStatus?: [string, string][]
  Images?: number
  ServerVersion?: string
  Labels?: string[]
}

export interface EngineImage {
  Id: string
  RepoTags: string[] | null
  RepoDigests: string[] | null
  Created: number
  Size: number
  Labels: Record<string, string> | null
}

export class DockerEngineError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_RUNNING' | 'NOT_FOUND' | 'API' | 'UNSUPPORTED',
    readonly status?: number
  ) {
    super(message)
  }
}

export class DockerEngine {
  private readonly agent: Agent
  private readonly base: string

  constructor(readonly endpoint: DockerEndpoint) {
    const uri = endpoint.uri
    const sock = endpointSocketPath(uri)
    if (sock) {
      this.agent = new Agent({ connect: { socketPath: sock }, headersTimeout: 0, bodyTimeout: 0 })
      this.base = 'http://docker'
    } else if (uri.startsWith('tcp://') || uri.startsWith('http://') || uri.startsWith('https://')) {
      const tls = endpoint.tls
      const secure = uri.startsWith('https://') || !!tls?.cert || !!tls?.verify
      const hostPort = uri.replace(/^(tcp|https?):\/\//, '')
      this.base = `${secure ? 'https' : 'http'}://${hostPort}`
      this.agent = new Agent({
        connect: tls ? { ca: tls.ca, cert: tls.cert, key: tls.key, rejectUnauthorized: tls.verify } : {},
        headersTimeout: 0,
        bodyTimeout: 0
      })
    } else {
      throw new DockerEngineError(
        `Unsupported Docker endpoint "${uri}" (ssh:// is not supported; use a unix, npipe or tcp endpoint)`,
        'UNSUPPORTED'
      )
    }
  }

  close(): Promise<void> {
    return this.agent.close()
  }

  private async call(
    path: string,
    init: {
      method?: string
      body?: Readable
      headers?: Record<string, string>
      signal?: AbortSignal
      timeoutMs?: number
    } = {}
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = init.timeoutMs ? setTimeout(() => controller.abort(), init.timeoutMs) : undefined
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
    let res: Response
    try {
      res = await fetch(`${this.base}${path}`, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        dispatcher: this.agent,
        signal,
        ...(init.body ? { duplex: 'half' } : {})
      } as Parameters<typeof fetch>[1])
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string; message?: string } }
      if (e.name === 'AbortError' && !init.signal?.aborted)
        throw new DockerEngineError('Docker engine did not respond in time', 'NOT_RUNNING')
      if (e.name === 'AbortError') throw err
      const code = e.cause?.code
      if (code === 'ENOENT')
        throw new DockerEngineError(`Docker socket not found (${this.endpoint.uri})`, 'NOT_FOUND')
      if (code === 'ECONNREFUSED' || code === 'EACCES' || code === 'EPERM') {
        throw new DockerEngineError(
          code === 'ECONNREFUSED'
            ? 'Docker engine is not running'
            : `Permission denied on ${this.endpoint.uri} (on Linux add your user to the "docker" group)`,
          'NOT_RUNNING'
        )
      }
      throw new DockerEngineError(
        `Cannot reach Docker engine at ${this.endpoint.uri}: ${e.cause?.message ?? (err as Error).message}`,
        'NOT_RUNNING'
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { message?: string }
        if (body.message) msg = body.message
      } catch {
        /* ignore */
      }
      throw new DockerEngineError(msg, 'API', res.status)
    }
    return res
  }

  async ping(): Promise<void> {
    const res = await this.call('/_ping', { timeoutMs: 5000 })
    await res.body?.cancel()
  }

  async version(): Promise<EngineVersion> {
    return (await (await this.call('/version', { timeoutMs: 10_000 })).json()) as EngineVersion
  }

  async info(): Promise<EngineInfo> {
    return (await (await this.call('/info', { timeoutMs: 15_000 })).json()) as EngineInfo
  }

  async listImages(): Promise<EngineImage[]> {
    return (await (await this.call('/images/json', { timeoutMs: 30_000 })).json()) as EngineImage[]
  }

  async removeImage(name: string, force: boolean): Promise<void> {
    const res = await this.call(`/images/${encodeURIComponent(name)}?force=${force ? 1 : 0}`, {
      method: 'DELETE',
      timeoutMs: 60_000
    })
    await res.body?.cancel()
  }

  async tagImage(source: string, repo: string, tag: string): Promise<void> {
    const res = await this.call(
      `/images/${encodeURIComponent(source)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
      { method: 'POST', timeoutMs: 30_000 }
    )
    await res.body?.cancel()
  }

  /** POST /images/load — the equivalent of `docker load`. Returns the loaded image names/ids. */
  async loadImage(tar: Readable, signal?: AbortSignal): Promise<string[]> {
    const res = await this.call('/images/load?quiet=1', {
      method: 'POST',
      body: tar,
      headers: { 'Content-Type': 'application/x-tar' },
      signal
    })
    const text = await res.text()
    const loaded: string[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let msg: { stream?: string; error?: string; errorDetail?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.error || msg.errorDetail)
        throw new DockerEngineError(msg.errorDetail?.message ?? msg.error ?? 'docker load failed', 'API')
      const m = /Loaded image(?: ID)?: (\S+)/.exec(msg.stream ?? '')
      if (m) loaded.push(m[1])
    }
    return loaded
  }

  /** GET /images/{name}/get — the equivalent of `docker save`. */
  async saveImage(name: string, signal?: AbortSignal): Promise<Readable> {
    const res = await this.call(`/images/${encodeURIComponent(name)}/get`, { signal })
    if (!res.body) throw new DockerEngineError('Empty response from docker save', 'API')
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  }
}
