import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { JsonFile } from '../store/json-file'
import { deriveKey, newKdfParams, open, seal, type KdfParams, type Sealed } from './crypto'

/** OS keychain adapter (Electron safeStorage in the app, a fake in tests). */
export interface Keychain {
  isAvailable(): boolean
  encrypt(data: Buffer): Buffer
  decrypt(data: Buffer): Buffer
}

interface VaultFile {
  version: 1
  kdf: KdfParams
  /** Random data key, encrypted with the key derived from the master password. */
  wrappedKey: Sealed
  /** Data key encrypted by the OS keychain, when "unlock with keychain" is enabled. */
  keychainKey?: string
  /** All secrets, encrypted with the data key. */
  secrets: Sealed
}

export type SecretMap = Record<string, Record<string, string>>

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code:
      'NOT_INITIALIZED' | 'ALREADY_INITIALIZED' | 'LOCKED' | 'BAD_PASSWORD' | 'RATE_LIMITED' | 'KEYCHAIN'
  ) {
    super(message)
  }
}

const AAD_KEY = 'helix-vault:data-key:v1'
const AAD_SECRETS = 'helix-vault:secrets:v1'

export class Vault {
  private readonly file: JsonFile<VaultFile | Record<string, never>>
  private dataKey: Buffer | undefined
  private secrets: SecretMap | undefined
  private failures = 0
  private lockedUntil = 0

  constructor(
    private readonly path: string,
    private readonly keychain?: Keychain,
    private readonly kdfOverrides: Partial<Omit<KdfParams, 'alg' | 'salt'>> = {},
    private readonly now: () => number = Date.now
  ) {
    this.file = new JsonFile(path, () => ({}))
  }

  isInitialized(): boolean {
    return existsSync(this.path) && 'wrappedKey' in this.file.read()
  }

  isUnlocked(): boolean {
    return this.dataKey !== undefined
  }

  keychainAvailable(): boolean {
    return !!this.keychain?.isAvailable()
  }

  keychainEnabled(): boolean {
    const f = this.file.read()
    return 'keychainKey' in f && !!f.keychainKey
  }

  retryAfterSec(): number {
    return Math.max(0, Math.ceil((this.lockedUntil - this.now()) / 1000))
  }

  async setup(password: string): Promise<void> {
    if (this.isInitialized()) throw new VaultError('Vault already exists', 'ALREADY_INITIALIZED')
    const dataKey = randomBytes(32)
    const kdf = newKdfParams(this.kdfOverrides)
    const kek = await deriveKey(password, kdf)
    try {
      this.dataKey = dataKey
      this.secrets = {}
      this.file.write({
        version: 1,
        kdf,
        wrappedKey: seal(kek, dataKey, AAD_KEY),
        secrets: seal(dataKey, Buffer.from('{}'), AAD_SECRETS)
      })
    } finally {
      kek.fill(0)
    }
  }

  async unlock(password: string): Promise<void> {
    const f = this.requireFile()
    if (this.retryAfterSec() > 0) {
      throw new VaultError(`Too many attempts. Try again in ${this.retryAfterSec()}s`, 'RATE_LIMITED')
    }
    const kek = await deriveKey(password, f.kdf)
    let dataKey: Buffer
    try {
      dataKey = open(kek, f.wrappedKey, AAD_KEY)
    } catch {
      this.failures++
      // Exponential backoff after the third failure: 2s, 4s, 8s … capped at 5 minutes.
      if (this.failures >= 3) this.lockedUntil = this.now() + Math.min(300, 2 ** (this.failures - 2)) * 1000
      throw new VaultError('Incorrect master password', 'BAD_PASSWORD')
    } finally {
      kek.fill(0)
    }
    this.failures = 0
    this.lockedUntil = 0
    this.load(dataKey, f)
  }

  unlockWithKeychain(): void {
    const f = this.requireFile()
    if (!f.keychainKey || !this.keychain?.isAvailable()) {
      throw new VaultError('Keychain unlock is not enabled', 'KEYCHAIN')
    }
    let dataKey: Buffer
    try {
      dataKey = this.keychain.decrypt(Buffer.from(f.keychainKey, 'base64'))
    } catch {
      throw new VaultError('The OS keychain could not decrypt the vault key', 'KEYCHAIN')
    }
    this.load(dataKey, f)
  }

  lock(): void {
    this.dataKey?.fill(0)
    this.dataKey = undefined
    this.secrets = undefined
  }

  async changePassword(current: string, next: string): Promise<void> {
    const f = this.requireFile()
    const kek = await deriveKey(current, f.kdf)
    let dataKey: Buffer
    try {
      dataKey = open(kek, f.wrappedKey, AAD_KEY)
    } catch {
      throw new VaultError('Current password is incorrect', 'BAD_PASSWORD')
    } finally {
      kek.fill(0)
    }
    const kdf = newKdfParams(this.kdfOverrides)
    const newKek = await deriveKey(next, kdf)
    try {
      // Only the data key is re-wrapped; secrets stay encrypted with the same data key.
      this.file.write({ ...f, kdf, wrappedKey: seal(newKek, dataKey, AAD_KEY) })
    } finally {
      newKek.fill(0)
    }
    this.load(dataKey, this.requireFile())
  }

  setKeychainUnlock(enabled: boolean): void {
    const f = this.requireFile()
    const key = this.requireKey()
    if (enabled) {
      if (!this.keychain?.isAvailable()) throw new VaultError('OS keychain is not available', 'KEYCHAIN')
      this.file.write({ ...f, keychainKey: this.keychain.encrypt(key).toString('base64') })
    } else {
      const { keychainKey: _drop, ...rest } = f
      this.file.write(rest)
    }
  }

  reset(): void {
    this.lock()
    this.failures = 0
    this.lockedUntil = 0
    rmSync(this.path, { force: true })
    this.file.invalidate()
  }

  get(id: string): Record<string, string> | undefined {
    const s = this.requireSecrets()[id]
    return s ? { ...s } : undefined
  }

  set(id: string, value: Record<string, string>): void {
    const secrets = this.requireSecrets()
    secrets[id] = { ...value }
    this.persist()
  }

  delete(id: string): void {
    const secrets = this.requireSecrets()
    delete secrets[id]
    this.persist()
  }

  ids(): string[] {
    return Object.keys(this.requireSecrets())
  }

  private load(dataKey: Buffer, f: VaultFile): void {
    const json = open(dataKey, f.secrets, AAD_SECRETS).toString('utf8')
    this.dataKey = dataKey
    this.secrets = JSON.parse(json) as SecretMap
  }

  private persist(): void {
    const f = this.requireFile()
    const key = this.requireKey()
    this.file.write({ ...f, secrets: seal(key, Buffer.from(JSON.stringify(this.secrets)), AAD_SECRETS) })
  }

  private requireFile(): VaultFile {
    const f = this.file.read()
    if (!('wrappedKey' in f)) throw new VaultError('Vault has not been set up', 'NOT_INITIALIZED')
    return f as VaultFile
  }

  private requireKey(): Buffer {
    if (!this.dataKey) throw new VaultError('Vault is locked', 'LOCKED')
    return this.dataKey
  }

  private requireSecrets(): SecretMap {
    if (!this.secrets) throw new VaultError('Vault is locked', 'LOCKED')
    return this.secrets
  }
}
