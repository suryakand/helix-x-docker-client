import type { Preferences, Settings } from '@helix/shared/types'

export function defaultSettings(downloadDir: string): Settings {
  return {
    autoLockMinutes: 15,
    lockOnSleep: true,
    proxy: { mode: 'system', url: '', noProxy: 'localhost,127.0.0.1' },
    caFiles: [],
    downloadDir,
    jobConcurrency: 2,
    blobConcurrency: 4,
    requestTimeoutSec: 120,
    logLevel: 'info',
    dockerHost: '',
    blobCache: { enabled: true, maxSizeGb: 10 },
    allowDeletes: true
  }
}

export function defaultPreferences(): Preferences {
  return {
    theme: 'system',
    density: 'comfortable',
    language: 'en',
    startupPage: 'explorer',
    dateFormat: 'relative',
    sizeUnits: 'si',
    confirmDeletes: true,
    defaultPlatform: 'auto',
    localTagStyle: 'full',
    pageSize: 100
  }
}
