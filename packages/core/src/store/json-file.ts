import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Small JSON document persisted atomically (write temp file + rename). */
export class JsonFile<T extends object> {
  private cache: T | undefined

  constructor(
    private readonly path: string,
    private readonly defaults: () => T,
    private readonly mode = 0o600
  ) {}

  read(): T {
    if (this.cache) return this.cache
    let value: T
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      value = mergeDefaults(this.defaults(), parsed)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Keep a copy of the unreadable file instead of silently overwriting it.
        try {
          renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
        } catch {
          /* ignore */
        }
      }
      value = this.defaults()
    }
    this.cache = value
    return value
  }

  write(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: this.mode })
    renameSync(tmp, this.path)
    this.cache = value
  }

  /** Forget the in-memory copy (e.g. after the file was deleted). */
  invalidate(): void {
    this.cache = undefined
  }

  update(fn: (current: T) => T): T {
    const next = fn(structuredClone(this.read()))
    this.write(next)
    return next
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge persisted values over defaults so new settings get sensible values after upgrades. */
export function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(stored)) return (stored ?? defaults) as T
  const out: Record<string, unknown> = { ...defaults }
  for (const [k, v] of Object.entries(stored)) {
    out[k] = k in out && isPlainObject(out[k]) ? mergeDefaults(out[k], v) : v
  }
  return out as T
}
