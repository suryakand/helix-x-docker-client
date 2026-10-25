import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Vault, type Keychain } from '../../src/vault/vault'

// Cheap KDF parameters keep the suite fast; production uses 64 MiB / 3 iterations.
const FAST = { memoryKiB: 1024, iterations: 1, parallelism: 1 }

const fakeKeychain: Keychain = {
  isAvailable: () => true,
  encrypt: (b) => Buffer.from(b.toString('base64').split('').reverse().join('')),
  decrypt: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'base64')
}

describe('Vault', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-'))
    path = join(dir, 'vault.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sets up, stores secrets encrypted and unlocks again', async () => {
    const v = new Vault(path, undefined, FAST)
    expect(v.isInitialized()).toBe(false)
    await v.setup('correct horse battery')
    v.set('reg-1', { username: 'alice', password: 's3cr3t-token' })
    expect(readFileSync(path, 'utf8')).not.toContain('s3cr3t-token')
    v.lock()
    expect(() => v.get('reg-1')).toThrow(/locked/)

    const v2 = new Vault(path, undefined, FAST)
    await v2.unlock('correct horse battery')
    expect(v2.get('reg-1')).toEqual({ username: 'alice', password: 's3cr3t-token' })
  })

  it('rejects a wrong password and rate limits repeated failures', async () => {
    let now = 1_000_000
    const v = new Vault(path, undefined, FAST, () => now)
    await v.setup('password-1')
    v.lock()
    for (let i = 0; i < 3; i++) await expect(v.unlock('nope')).rejects.toThrow(/Incorrect/)
    expect(v.retryAfterSec()).toBeGreaterThan(0)
    await expect(v.unlock('password-1')).rejects.toThrow(/Too many attempts/)
    now += 10_000
    await v.unlock('password-1')
    expect(v.isUnlocked()).toBe(true)
  })

  it('changes the master password without losing secrets', async () => {
    const v = new Vault(path, undefined, FAST)
    await v.setup('old-password')
    v.set('x', { token: 'abc' })
    await expect(v.changePassword('wrong', 'new-password')).rejects.toThrow(/incorrect/)
    await v.changePassword('old-password', 'new-password')
    v.lock()
    await expect(v.unlock('old-password')).rejects.toThrow()
    await v.unlock('new-password')
    expect(v.get('x')).toEqual({ token: 'abc' })
  })

  it('unlocks through the OS keychain when enabled', async () => {
    const v = new Vault(path, fakeKeychain, FAST)
    await v.setup('pw-12345678')
    v.set('a', { password: 'p' })
    v.setKeychainUnlock(true)
    v.lock()
    const v2 = new Vault(path, fakeKeychain, FAST)
    expect(v2.keychainEnabled()).toBe(true)
    v2.unlockWithKeychain()
    expect(v2.get('a')).toEqual({ password: 'p' })
    v2.setKeychainUnlock(false)
    expect(v2.keychainEnabled()).toBe(false)
  })

  it('detects tampering with the encrypted secrets', async () => {
    const v = new Vault(path, undefined, FAST)
    await v.setup('pw-12345678')
    v.set('a', { password: 'p' })
    const f = JSON.parse(readFileSync(path, 'utf8'))
    f.secrets.ct = Buffer.from('tampered').toString('base64')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, JSON.stringify(f))
    const v2 = new Vault(path, undefined, FAST)
    await expect(v2.unlock('pw-12345678')).rejects.toThrow()
  })

  it('reset removes the vault', async () => {
    const v = new Vault(path, undefined, FAST)
    await v.setup('pw-12345678')
    v.reset()
    expect(v.isInitialized()).toBe(false)
    await v.setup('another-password')
    expect(v.isUnlocked()).toBe(true)
  })
})
