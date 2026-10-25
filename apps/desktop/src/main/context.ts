// Composition root: builds every service once and keeps the cross-cutting rules
// (vault must be unlocked, caches invalidated on change, events broadcast) in one place.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Notification, powerMonitor, safeStorage, systemPreferences } from 'electron'
import log from 'electron-log/main'
import { EVENT_CHANNEL } from '@helix/shared/api'
import type { AppEvent, Job, Preferences, Settings, VaultStatus } from '@helix/shared/types'
import { DockerService } from '@helix/core/docker/service'
import { RegistryService } from '@helix/core/registry/service'
import { defaultPreferences, defaultSettings } from '@helix/core/store/defaults'
import { JsonFile } from '@helix/core/store/json-file'
import { RegistryStore } from '@helix/core/store/registries'
import { BlobStore } from '@helix/core/transfer/blob-store'
import { JobManager } from '@helix/core/transfer/jobs'
import { Vault, type Keychain } from '@helix/core/vault/vault'

export function broadcast(event: AppEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, event)
  }
}

const electronKeychain: Keychain = {
  isAvailable: () => {
    if (!safeStorage.isEncryptionAvailable()) return false
    // On Linux without a secret service, safeStorage falls back to a hard-coded key; do not offer it then.
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.()
      return backend !== 'basic_text' && backend !== 'unknown'
    }
    return true
  },
  encrypt: (data) => safeStorage.encryptString(data.toString('base64')),
  decrypt: (data) => Buffer.from(safeStorage.decryptString(data), 'base64')
}

export class AppContext {
  readonly paths: { userData: string; cache: string; tmp: string; logs: string }
  readonly settingsFile: JsonFile<Settings>
  readonly prefsFile: JsonFile<Preferences>
  readonly vault: Vault
  readonly registries: RegistryStore
  readonly registryService: RegistryService
  readonly docker: DockerService
  readonly jobs: JobManager
  private lockTimer: NodeJS.Timeout | undefined
  /** Running / queued jobs, for the dock / taskbar progress bar. */
  private activeJobs = new Map<string, Job>()

  constructor() {
    const userData = app.getPath('userData')
    this.paths = {
      userData,
      cache: join(userData, 'blob-cache'),
      tmp: join(app.getPath('temp'), 'helix-x-docker-client'),
      logs: app.getPath('logs')
    }
    mkdirSync(this.paths.tmp, { recursive: true })

    this.settingsFile = new JsonFile(join(userData, 'settings.json'), () =>
      defaultSettings(app.getPath('downloads'))
    )
    this.prefsFile = new JsonFile(join(userData, 'preferences.json'), defaultPreferences)
    this.vault = new Vault(join(userData, 'vault.json'), electronKeychain)
    this.registries = new RegistryStore(join(userData, 'registries.json'), this.vault)
    this.registryService = new RegistryService(
      this.registries,
      () => this.settings(),
      () => this.prefsFile.read().pageSize
    )
    this.docker = new DockerService(
      () => this.settings().dockerHost,
      join(userData, 'loaded-images.json'),
      (status) => broadcast({ type: 'docker', status })
    )
    this.jobs = new JobManager({
      registries: this.registryService,
      docker: this.docker,
      settings: () => this.settings(),
      preferences: () => this.prefsFile.read(),
      cacheDir: this.paths.cache,
      tmpDir: this.paths.tmp,
      historyPath: join(userData, 'jobs.json'),
      emit: (job) => this.onJob(job),
      emitRemoved: (id) => broadcast({ type: 'job-removed', id }),
      log: (level, msg) => log[level](msg)
    })
    log.transports.file.level = this.settings().logLevel
  }

  settings(): Settings {
    return this.settingsFile.read()
  }

  blobStore(): BlobStore {
    return new BlobStore(this.paths.cache, this.settings().blobCache.maxSizeGb * 1024 ** 3)
  }

  vaultStatus(): VaultStatus {
    return {
      initialized: this.vault.isInitialized(),
      unlocked: this.vault.isUnlocked(),
      keychainAvailable: this.vault.keychainAvailable(),
      keychainEnabled: this.vault.isInitialized() && this.vault.keychainEnabled(),
      biometricAvailable: process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
      retryAfterSec: this.vault.retryAfterSec()
    }
  }

  async unlockWithKeychain(): Promise<void> {
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      await systemPreferences.promptTouchID('unlock Helix-X Docker Client')
    }
    this.vault.unlockWithKeychain()
  }

  onVaultChanged(): void {
    // Clients hold credentials; rebuild them whenever the vault opens or closes.
    this.registryService.invalidate()
    broadcast({ type: 'vault', status: this.vaultStatus() })
  }

  lock(reason: string): void {
    if (!this.vault.isUnlocked()) return
    log.info(`Locking vault (${reason})`)
    this.vault.lock()
    this.onVaultChanged()
  }

  /** Auto-lock on system idle and on sleep / screen lock. */
  startAutoLock(): void {
    this.lockTimer = setInterval(() => {
      const minutes = this.settings().autoLockMinutes
      if (minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) this.lock('idle timeout')
    }, 30_000)
    const onSleep = () => {
      if (this.settings().lockOnSleep) this.lock('system sleep / screen lock')
    }
    powerMonitor.on('suspend', onSleep)
    powerMonitor.on('lock-screen', onSleep)
  }

  /** Forward job updates to the UI, drive the dock / taskbar progress bar and notify when work finishes. */
  private onJob(job: Job): void {
    broadcast({ type: 'job', job })
    if (job.status === 'running' || job.status === 'queued') {
      this.activeJobs.set(job.id, job)
    } else if (this.activeJobs.delete(job.id) && (job.status === 'done' || job.status === 'failed')) {
      this.notifyFinished(job)
    }
    this.updateProgressBar()
  }

  private updateProgressBar(): void {
    const jobs = [...this.activeJobs.values()]
    const total = jobs.reduce((a, j) => a + j.bytesTotal, 0)
    const done = jobs.reduce((a, j) => a + Math.min(j.bytesDone, j.bytesTotal), 0)
    // -1 removes the bar; a value above 1 shows an indeterminate bar (sizes not known yet).
    const value = jobs.length === 0 ? -1 : total > 0 ? done / total : 2
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setProgressBar(value)
  }

  /** System notification for finished transfers, only when the app is in the background (in-app toasts otherwise). */
  private notifyFinished(job: Job): void {
    if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return
    const n = new Notification({
      title: job.status === 'done' ? 'Transfer complete' : 'Transfer failed',
      body: job.status === 'done' ? job.title : `${job.title}\n${job.error ?? ''}`.trim(),
      silent: job.status === 'done'
    })
    n.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      }
      broadcast({ type: 'navigate', path: '/transfers' })
    })
    n.show()
  }

  dispose(): void {
    if (this.lockTimer) clearInterval(this.lockTimer)
    this.jobs.cancelAll()
    this.docker.dispose()
    this.registryService.invalidate()
    this.vault.lock()
  }
}
