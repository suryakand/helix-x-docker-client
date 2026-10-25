import { randomUUID } from 'node:crypto'
import { getProvider } from '@helix/shared/providers'
import type { RegistryConfig, RegistryCredentials, RegistryInput, RegistrySummary } from '@helix/shared/types'
import type { Vault } from '../vault/vault'
import { JsonFile } from './json-file'

interface RegistriesFile {
  version: 1
  registries: RegistryConfig[]
}

/** Registry connection metadata lives in registries.json; secrets live only in the encrypted vault. */
export class RegistryStore {
  private readonly file: JsonFile<RegistriesFile>

  constructor(
    path: string,
    private readonly vault: Vault
  ) {
    this.file = new JsonFile(path, () => ({ version: 1, registries: [] }))
  }

  list(): RegistryConfig[] {
    return this.file.read().registries
  }

  get(id: string): RegistryConfig {
    const r = this.list().find((x) => x.id === id)
    if (!r) throw new Error(`Registry not found: ${id}`)
    return r
  }

  secrets(id: string): RegistryCredentials {
    return this.vault.isUnlocked() ? (this.vault.get(id) ?? {}) : {}
  }

  summaries(): RegistrySummary[] {
    return this.list().map((r) => this.summary(r))
  }

  summary(r: RegistryConfig): RegistrySummary {
    const secrets = this.secrets(r.id)
    const fields = getProvider(r.type).credentials
    const hints: Record<string, string> = {}
    for (const f of fields) {
      const v = secrets[f.key]
      if (!v) continue
      // Usernames / key ids are shown so users can tell accounts apart; secrets are never sent back.
      hints[f.key] = f.kind === 'text' ? v : 'saved'
    }
    return { ...r, hasCredentials: Object.keys(hints).length > 0, credentialHints: hints }
  }

  create(input: RegistryInput): RegistryConfig {
    const now = new Date().toISOString()
    const isFirst = this.list().length === 0
    const config: RegistryConfig = {
      ...clean(input.config),
      pinnedRepos: input.config.pinnedRepos ?? [],
      id: randomUUID(),
      isDefault: isFirst,
      createdAt: now,
      updatedAt: now
    }
    if (input.credentials) this.vault.set(config.id, compact(input.credentials))
    this.file.update((f) => ({ ...f, registries: [...f.registries, config] }))
    return config
  }

  update(id: string, input: RegistryInput): RegistryConfig {
    const existing = this.get(id)
    const next: RegistryConfig = {
      ...existing,
      ...clean(input.config),
      pinnedRepos: input.config.pinnedRepos ?? existing.pinnedRepos,
      updatedAt: new Date().toISOString()
    }
    if (input.credentials) this.vault.set(id, mergeSecrets(this.secrets(id), input.credentials))
    this.file.update((f) => ({ ...f, registries: f.registries.map((r) => (r.id === id ? next : r)) }))
    return next
  }

  remove(id: string): void {
    const wasDefault = this.get(id).isDefault
    if (this.vault.isUnlocked()) this.vault.delete(id)
    this.file.update((f) => {
      const registries = f.registries.filter((r) => r.id !== id)
      if (wasDefault && registries[0]) registries[0] = { ...registries[0], isDefault: true }
      return { ...f, registries }
    })
  }

  duplicate(id: string): RegistryConfig {
    const src = this.get(id)
    const { id: _id, createdAt: _c, updatedAt: _u, isDefault: _d, ...config } = src
    return this.create({ config: { ...config, name: `${src.name} (copy)` }, credentials: this.secrets(id) })
  }

  setDefault(id: string): void {
    this.get(id)
    this.file.update((f) => ({
      ...f,
      registries: f.registries.map((r) => ({ ...r, isDefault: r.id === id }))
    }))
  }

  setPinned(id: string, repos: string[]): void {
    this.file.update((f) => ({
      ...f,
      registries: f.registries.map((r) => (r.id === id ? { ...r, pinnedRepos: [...new Set(repos)] } : r))
    }))
  }

  /** Replace or add registries from a backup (ids are preserved so re-importing updates instead of duplicating). */
  importMany(items: { config: RegistryConfig; secrets?: RegistryCredentials }[]): number {
    this.file.update((f) => {
      const byId = new Map(f.registries.map((r) => [r.id, r]))
      for (const { config } of items)
        byId.set(config.id, { ...config, isDefault: byId.get(config.id)?.isDefault ?? false })
      const registries = [...byId.values()]
      if (!registries.some((r) => r.isDefault) && registries[0]) registries[0].isDefault = true
      return { ...f, registries }
    })
    for (const { config, secrets } of items)
      if (secrets && Object.keys(secrets).length) this.vault.set(config.id, secrets)
    return items.length
  }
}

function clean(
  c: RegistryInput['config']
): Omit<RegistryConfig, 'id' | 'createdAt' | 'updatedAt' | 'isDefault' | 'pinnedRepos'> {
  const provider = getProvider(c.type)
  return {
    name: c.name.trim(),
    type: c.type,
    url: (provider.urlLocked && provider.defaultUrl ? provider.defaultUrl : c.url).trim().replace(/\/+$/, ''),
    namespace: c.namespace?.trim() || undefined,
    region: c.region?.trim() || undefined,
    apiUrl: c.apiUrl?.trim() || undefined,
    color: c.color,
    tls: {
      insecureSkipVerify: !!c.tls.insecureSkipVerify,
      plainHttp: !!c.tls.plainHttp,
      caFile: c.tls.caFile || undefined
    }
  }
}

function compact(c: RegistryCredentials): RegistryCredentials {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== ''))
}

/** On update a missing key keeps the stored value, an empty string clears it. */
export function mergeSecrets(current: RegistryCredentials, patch: RegistryCredentials): RegistryCredentials {
  const out = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (v === '') delete out[k]
    else out[k] = v
  }
  return out
}
