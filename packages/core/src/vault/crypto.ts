import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { argon2id } from 'hash-wasm'

export interface KdfParams {
  alg: 'argon2id'
  salt: string // base64
  memoryKiB: number
  iterations: number
  parallelism: number
}

export interface Sealed {
  iv: string // base64, 12 bytes
  tag: string // base64, 16 bytes
  ct: string // base64
}

export const DEFAULT_KDF = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 }

export function newKdfParams(overrides: Partial<Omit<KdfParams, 'alg' | 'salt'>> = {}): KdfParams {
  return { alg: 'argon2id', salt: randomBytes(16).toString('base64'), ...DEFAULT_KDF, ...overrides }
}

export async function deriveKey(password: string, params: KdfParams): Promise<Buffer> {
  const hash = await argon2id({
    password: password.normalize('NFKC'),
    salt: Buffer.from(params.salt, 'base64'),
    memorySize: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary'
  })
  return Buffer.from(hash)
}

/** AES-256-GCM. `aad` binds the ciphertext to its purpose so blobs cannot be swapped. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') }
}

export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()])
}

/** Password based encryption of an arbitrary payload (used for config backups). */
export async function sealWithPassword(password: string, plaintext: Buffer, aad: string) {
  const kdf = newKdfParams()
  const key = await deriveKey(password, kdf)
  try {
    return { kdf, data: seal(key, plaintext, aad) }
  } finally {
    key.fill(0)
  }
}

export async function openWithPassword(password: string, box: { kdf: KdfParams; data: Sealed }, aad: string) {
  const key = await deriveKey(password, box.kdf)
  try {
    return open(key, box.data, aad)
  } finally {
    key.fill(0)
  }
}
