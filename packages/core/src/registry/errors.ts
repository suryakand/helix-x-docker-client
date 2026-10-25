import type { Response } from 'undici'

export type RegistryErrorCode =
  | 'UNAUTHORIZED'
  | 'DENIED'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'NETWORK'
  | 'TLS'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'DIGEST_MISMATCH'
  | 'CANCELLED'

export interface RegistryErrorOptions {
  /** Transient failure (connection reset, timeout, 429/5xx …): the operation may succeed if repeated. */
  retryable?: boolean
  /** Server-requested delay before retrying (Retry-After), in milliseconds. */
  retryAfterMs?: number
}

export class RegistryError extends Error {
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(
    message: string,
    readonly code: RegistryErrorCode,
    readonly status?: number,
    opts: RegistryErrorOptions = {}
  ) {
    super(message)
    this.name = 'RegistryError'
    this.retryable = opts.retryable ?? false
    this.retryAfterMs = opts.retryAfterMs
  }
}

/** Parse a Retry-After header (delta seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

interface DistributionErrorBody {
  errors?: { code?: string; message?: string; detail?: unknown }[]
  message?: string
  detail?: string
}

export async function errorFromResponse(res: Response, what: string): Promise<RegistryError> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const body = JSON.parse(text) as DistributionErrorBody
      detail =
        body.errors?.map((e) => [e.code, e.message].filter(Boolean).join(': ')).join('; ') ||
        body.message ||
        body.detail ||
        ''
    } catch {
      detail = text.slice(0, 300)
    }
  } catch {
    /* ignore */
  }
  const suffix = detail ? ` — ${detail}` : ''
  switch (res.status) {
    case 401:
      return new RegistryError(`Authentication failed for ${what}${suffix}`, 'UNAUTHORIZED', 401)
    case 403:
      return new RegistryError(`Access denied for ${what}${suffix}`, 'DENIED', 403)
    case 404:
      return new RegistryError(`Not found: ${what}${suffix}`, 'NOT_FOUND', 404)
    case 405:
      return new RegistryError(
        `Operation not supported by this registry (${what})${suffix}`,
        'UNSUPPORTED',
        405
      )
    default: {
      const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504
      return new RegistryError(
        `Registry returned HTTP ${res.status} for ${what}${suffix}`,
        'PROTOCOL',
        res.status,
        {
          retryable: transient,
          retryAfterMs: transient ? parseRetryAfter(res.headers.get('retry-after')) : undefined
        }
      )
    }
  }
}

/** Turn low level fetch/undici failures into readable messages. */
export function networkError(err: unknown, url: string): Error {
  if (err instanceof RegistryError) return err
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'AbortError') return new RegistryError('Cancelled', 'CANCELLED')
  const code = e?.cause?.code ?? ''
  const host = safeHost(url)
  if (
    /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code) ||
    /certificate/i.test(e?.cause?.message ?? '')
  ) {
    return new RegistryError(
      `TLS certificate problem talking to ${host} (${code || e?.cause?.message}). Add the CA certificate or enable "skip TLS verification" for this registry.`,
      'TLS'
    )
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return new RegistryError(`Host not found: ${host}`, 'NETWORK')
  if (code === 'ECONNREFUSED') return new RegistryError(`Connection refused by ${host}`, 'NETWORK')
  const transient = { retryable: true }
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'ETIMEDOUT'
  ) {
    return new RegistryError(`Timed out talking to ${host}`, 'TIMEOUT', undefined, transient)
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return new RegistryError(`Connection reset by ${host}`, 'NETWORK', undefined, transient)
  }
  if (/wrong version number|EPROTO/i.test(`${code} ${e?.cause?.message}`)) {
    return new RegistryError(
      `${host} does not speak HTTPS. Enable "plain HTTP" for this registry if that is intended.`,
      'TLS'
    )
  }
  return new RegistryError(
    `Network error talking to ${host}: ${e?.cause?.message ?? e?.message ?? String(err)}`,
    'NETWORK',
    undefined,
    transient
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
