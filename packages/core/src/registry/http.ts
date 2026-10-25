import { readFileSync } from 'node:fs'
import { rootCertificates } from 'node:tls'
import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici'
import type { RegistryTls, Settings } from '@helix/shared/types'

export interface NetworkOptions {
  timeoutMs: number
  proxy: Settings['proxy']
  caFiles: string[]
}

function readCa(files: string[]): string[] {
  const out: string[] = []
  for (const f of files) {
    if (!f) continue
    try {
      out.push(readFileSync(f, 'utf8'))
    } catch (err) {
      throw new Error(`Cannot read CA certificate file ${f}: ${(err as Error).message}`, { cause: err })
    }
  }
  return out
}

/** Build an undici dispatcher honoring per-registry TLS options and global proxy / CA settings. */
export function createDispatcher(
  tls: Pick<RegistryTls, 'insecureSkipVerify' | 'caFile'>,
  net: NetworkOptions
): Dispatcher {
  const extraCa = readCa([...net.caFiles, ...(tls.caFile ? [tls.caFile] : [])])
  const tlsOptions = {
    rejectUnauthorized: !tls.insecureSkipVerify,
    ...(extraCa.length ? { ca: [...rootCertificates, ...extraCa] } : {})
  }
  const timeouts = {
    headersTimeout: net.timeoutMs,
    bodyTimeout: net.timeoutMs,
    connectTimeout: Math.min(net.timeoutMs, 30_000)
  }

  if (net.proxy.mode === 'manual' && net.proxy.url) {
    return new EnvHttpProxyAgent({
      httpProxy: net.proxy.url,
      httpsProxy: net.proxy.url,
      noProxy: net.proxy.noProxy,
      connect: tlsOptions,
      requestTls: tlsOptions,
      ...timeouts
    })
  }
  if (net.proxy.mode === 'system' && hasEnvProxy()) {
    // "System" honours the standard HTTPS_PROXY / HTTP_PROXY / NO_PROXY environment variables.
    return new EnvHttpProxyAgent({ connect: tlsOptions, requestTls: tlsOptions, ...timeouts })
  }
  return new Agent({ connect: tlsOptions, ...timeouts })
}

function hasEnvProxy(): boolean {
  const e = process.env
  return !!(e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy)
}

export function normalizeRegistryUrl(url: string, plainHttp: boolean): string {
  let u = url.trim()
  if (!/^https?:\/\//i.test(u)) u = `${plainHttp ? 'http' : 'https'}://${u}`
  if (plainHttp) u = u.replace(/^https:/i, 'http:')
  const parsed = new URL(u)
  // Registry API always lives at /v2/ on the host; keep any path prefix out of the base URL.
  return `${parsed.protocol}//${parsed.host}`
}

export function registryHost(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host
  } catch {
    return url
  }
}

export const USER_AGENT = 'helix-x-docker-client'
