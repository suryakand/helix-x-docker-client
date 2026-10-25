// Retry policy for transient registry / network failures.
import { RegistryError } from './errors'

export interface RetryPolicy {
  /** Total attempts including the first one. */
  attempts: number
  /** First backoff delay; doubles on every retry (plus up to 50 % jitter). */
  baseDelayMs: number
  /** Upper bound for any single wait, including server-requested Retry-After. */
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseDelayMs: 500, maxDelayMs: 30_000 }

/**
 * True for failures worth repeating: classified transient registry errors, and stream errors that happen
 * while a response body is being read (undici reports those as "terminated" / socket errors, not RegistryError).
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RegistryError) return err.retryable
  const e = err as { name?: string; code?: string; cause?: { code?: string } } | undefined
  if (!e || e.name === 'AbortError') return false
  const code = e.code ?? e.cause?.code ?? ''
  return (
    /ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_(SOCKET|BODY_TIMEOUT|CLOSED)/.test(code) ||
    (e.name === 'TypeError' && /terminated/i.test(String((err as Error).message)))
  )
}

export function retryDelay(attempt: number, err: unknown, policy: RetryPolicy): number {
  const requested = err instanceof RegistryError ? err.retryAfterMs : undefined
  const backoff = policy.baseDelayMs * 2 ** (attempt - 1)
  const jitter = Math.random() * backoff * 0.5
  return Math.min(policy.maxDelayMs, requested ?? backoff + jitter)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new RegistryError('Cancelled', 'CANCELLED'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new RegistryError('Cancelled', 'CANCELLED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Run `fn` until it succeeds, a non-retryable error occurs, attempts run out or the signal aborts. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
  onRetry?: (attempt: number, err: unknown) => void
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      if (attempt >= policy.attempts || signal?.aborted || !isRetryable(err)) throw err
      onRetry?.(attempt, err)
      await sleep(retryDelay(attempt, err, policy), signal)
    }
  }
}
