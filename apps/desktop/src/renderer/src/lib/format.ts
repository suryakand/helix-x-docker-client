import type { Platform } from '@helix/shared/types'

export const api = window.helix

export function formatBytes(bytes: number | undefined, units: 'si' | 'iec' = 'si'): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '—'
  const base = units === 'si' ? 1000 : 1024
  const labels = units === 'si' ? ['B', 'kB', 'MB', 'GB', 'TB'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = Math.abs(bytes)
  let i = 0
  while (v >= base && i < labels.length - 1) {
    v /= base
    i++
  }
  return `${bytes < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${labels[i]}`
}

export function formatDate(
  value: string | number | undefined,
  style: 'relative' | 'absolute' = 'relative'
): string {
  if (value === undefined || value === '') return '—'
  const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value)
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1980) return '—'
  if (style === 'absolute') return d.toLocaleString()
  const diff = (Date.now() - d.getTime()) / 1000
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const units: [number, number, Intl.RelativeTimeFormatUnit][] = [
    [60, 1, 'second'],
    [3600, 60, 'minute'],
    [86400, 3600, 'hour'],
    [604800, 86400, 'day'],
    [2629800, 604800, 'week'],
    [31557600, 2629800, 'month'],
    [Infinity, 31557600, 'year']
  ]
  for (const [limit, div, unit] of units) {
    if (Math.abs(diff) < limit) return rtf.format(-Math.round(diff / div), unit)
  }
  return d.toLocaleDateString()
}

export function platformLabel(p?: Platform): string {
  if (!p) return 'unknown'
  return [p.os, p.architecture, p.variant].filter(Boolean).join('/')
}

export function shortDigest(d: string | undefined): string {
  if (!d) return '—'
  return d.replace(/^sha256:/, '').slice(0, 12)
}

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
