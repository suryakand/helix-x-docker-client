import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import type { HelixApi, IpcResult } from '@helix/shared/api'
import { ipcSchemas } from '@helix/shared/schemas'
import type { RegistryConfig, RegistryCredentials } from '@helix/shared/types'
import { broadcast, type AppContext } from '../context'
import { openWithPassword, sealWithPassword, type KdfParams, type Sealed } from '@helix/core/vault/crypto'
import { VaultError } from '@helix/core/vault/vault'
import { registryHost } from '@helix/core/registry/http'
import {
  defaultDockerLoginsEnv,
  mapDockerLogin,
  readDockerLogins,
  toCandidate,
  type DockerLogin
} from '@helix/core/store/docker-logins'
import { REGISTRY_COLORS } from '@helix/shared/providers'

type Impl = { [NS in keyof HelixApi]: { [M in keyof HelixApi[NS]]: HelixApi[NS][M] } }

/** Methods that work while the vault is locked (login screen, theme, about). */
const PUBLIC = new Set([
  'vault.status',
  'vault.setup',
  'vault.unlock',
  'vault.unlockWithKeychain',
  'vault.lock',
  'vault.reset',
  'settings.getPreferences',
  'app.info',
  'app.openLogs',
  'app.openExternal'
])

interface BackupFile {
  format: 'helix-x-registries'
  version: 1
  exportedAt: string
  registries: RegistryConfig[]
  secrets?: { kdf: KdfParams; data: Sealed }
}

const BACKUP_AAD = 'helix-x-registries-backup:v1'

export function registerIpc(ctx: AppContext): void {
  let currentEvent: IpcMainInvokeEvent | undefined
  const win = () =>
    (currentEvent ? BrowserWindow.fromWebContents(currentEvent.sender) : null) ??
    BrowserWindow.getFocusedWindow() ??
    undefined
  const registriesChanged = () => broadcast({ type: 'registries-changed' })
  /** Same registry host and user already configured in the app. */
  const alreadyAdded = (l: DockerLogin) => {
    const m = mapDockerLogin(l)
    const host = registryHost(m.url)
    return ctx.registries.list().some((r) => {
      if (registryHost(r.url) !== host) return false
      const user = ctx.registries.secrets(r.id).username
      return !user || !l.username || user === l.username || l.username === '<token>'
    })
  }

  const impl: Impl = {
    vault: {
      status: async () => ctx.vaultStatus(),
      setup: async (password) => {
        await ctx.vault.setup(password)
        ctx.onVaultChanged()
        return ctx.vaultStatus()
      },
      unlock: async (password) => {
        await ctx.vault.unlock(password)
        ctx.onVaultChanged()
        return ctx.vaultStatus()
      },
      unlockWithKeychain: async () => {
        await ctx.unlockWithKeychain()
        ctx.onVaultChanged()
        return ctx.vaultStatus()
      },
      lock: async () => {
        ctx.lock('user')
        return ctx.vaultStatus()
      },
      changePassword: async (current, next) => {
        await ctx.vault.changePassword(current, next)
        return ctx.vaultStatus()
      },
      setKeychainUnlock: async (enabled) => {
        ctx.vault.setKeychainUnlock(enabled)
        return ctx.vaultStatus()
      },
      reset: async () => {
        const res = await dialog.showMessageBox(win()!, {
          type: 'warning',
          buttons: ['Cancel', 'Reset vault'],
          defaultId: 0,
          cancelId: 0,
          message: 'Reset the credential vault?',
          detail:
            'All saved registry credentials are permanently deleted. Registry connections are kept without credentials.'
        })
        if (res.response === 1) {
          ctx.vault.reset()
          ctx.onVaultChanged()
        }
        return ctx.vaultStatus()
      }
    },

    registries: {
      list: async () => ctx.registries.summaries(),
      create: async (input) => {
        const r = ctx.registries.create(input)
        registriesChanged()
        return ctx.registries.summary(r)
      },
      update: async (id, input) => {
        const r = ctx.registries.update(id, input)
        ctx.registryService.invalidate(id)
        registriesChanged()
        return ctx.registries.summary(r)
      },
      remove: async (id) => {
        ctx.registries.remove(id)
        ctx.registryService.invalidate(id)
        registriesChanged()
      },
      duplicate: async (id) => {
        const r = ctx.registries.duplicate(id)
        registriesChanged()
        return ctx.registries.summary(r)
      },
      setDefault: async (id) => {
        ctx.registries.setDefault(id)
        registriesChanged()
      },
      setPinned: async (id, repos) => {
        ctx.registries.setPinned(id, repos)
        ctx.registryService.invalidate(id)
        registriesChanged()
      },
      test: async (input) => ctx.registryService.test(input),
      exportConfigs: async (includeSecrets, passphrase) => {
        if (includeSecrets && (!passphrase || passphrase.length < 8))
          throw new Error('A passphrase of at least 8 characters is required')
        const out = await dialog.showSaveDialog(win()!, {
          title: 'Export registry connections',
          defaultPath: `helix-registries-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (out.canceled || !out.filePath) return { count: 0 }
        const registries = ctx.registries.list()
        const backup: BackupFile = {
          format: 'helix-x-registries',
          version: 1,
          exportedAt: new Date().toISOString(),
          registries
        }
        if (includeSecrets && passphrase) {
          const secrets: Record<string, RegistryCredentials> = {}
          for (const r of registries) secrets[r.id] = ctx.registries.secrets(r.id)
          backup.secrets = await sealWithPassword(
            passphrase,
            Buffer.from(JSON.stringify(secrets)),
            BACKUP_AAD
          )
        }
        writeFileSync(out.filePath, JSON.stringify(backup, null, 2), { mode: 0o600 })
        return { path: out.filePath, count: registries.length }
      },
      scanDockerLogins: async () => {
        const env = defaultDockerLoginsEnv()
        const { logins, warnings } = await readDockerLogins(env)
        return {
          configPath: env.configPath,
          candidates: logins.map((l) => toCandidate(l, alreadyAdded(l))),
          warnings
        }
      },
      importDockerLogins: async (servers) => {
        const wanted = new Set(servers)
        const { logins } = await readDockerLogins(defaultDockerLoginsEnv())
        let count = 0
        for (const l of logins) {
          if (!wanted.has(l.server) || alreadyAdded(l)) continue
          const m = mapDockerLogin(l)
          if (!m.supported) continue
          ctx.registries.create({
            config: {
              name: m.name,
              type: m.type,
              url: m.url,
              namespace: m.namespace,
              color: REGISTRY_COLORS[(ctx.registries.list().length + count) % REGISTRY_COLORS.length],
              tls: { insecureSkipVerify: false, plainHttp: m.plainHttp }
            },
            credentials: m.credentials
          })
          count++
        }
        if (count) registriesChanged()
        return { count }
      },
      importConfigs: async (passphrase) => {
        const sel = await dialog.showOpenDialog(win()!, {
          title: 'Import registry connections',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (sel.canceled || !sel.filePaths[0]) return { count: 0 }
        const backup = JSON.parse(readFileSync(sel.filePaths[0], 'utf8')) as BackupFile
        if (backup.format !== 'helix-x-registries' || !Array.isArray(backup.registries))
          throw new Error('Not a Helix-X registry export')
        let secrets: Record<string, RegistryCredentials> = {}
        if (backup.secrets) {
          if (!passphrase) throw new Error('This export contains credentials; enter its passphrase to import')
          try {
            secrets = JSON.parse(
              (await openWithPassword(passphrase, backup.secrets, BACKUP_AAD)).toString('utf8')
            )
          } catch {
            throw new Error('Wrong passphrase for this export')
          }
        }
        const count = ctx.registries.importMany(
          backup.registries.map((config) => ({ config, secrets: secrets[config.id] }))
        )
        ctx.registryService.invalidate()
        registriesChanged()
        return { path: sel.filePaths[0], count }
      }
    },

    explorer: {
      listRepositories: (id, cursor) => ctx.registryService.listRepositories(id, cursor),
      listTags: (id, repo, cursor) => ctx.registryService.listTags(id, repo, cursor),
      tagSummary: (id, repo, tag) => ctx.registryService.tagSummary(id, repo, tag),
      imageDetails: (id, repo, ref, platform) => ctx.registryService.imageDetails(id, repo, ref, platform),
      deleteTag: (id, repo, ref) => ctx.registryService.deleteTag(id, repo, ref),
      retag: (id, repo, ref, newTag) => ctx.registryService.retag(id, repo, ref, newTag)
    },

    docker: {
      status: () => ctx.docker.status(),
      storageInfo: () => ctx.docker.storageInfo(),
      listImages: () => ctx.docker.listImages(),
      removeImage: (id, force) => ctx.docker.removeImage(id, force)
    },

    transfers: {
      list: async () => ctx.jobs.list(),
      start: async (spec) => ctx.jobs.start(spec),
      cancel: async (id) => ctx.jobs.cancel(id),
      retry: async (id) => ctx.jobs.retry(id),
      clearFinished: async () => ctx.jobs.clearFinished()
    },

    settings: {
      get: async () => ctx.settings(),
      update: async (patch) => {
        const next = ctx.settingsFile.update((s) => ({ ...s, ...patch }))
        log.transports.file.level = next.logLevel
        // Network / TLS / proxy settings are baked into clients.
        ctx.registryService.invalidate()
        if (patch.dockerHost !== undefined) void ctx.docker.status()
        return next
      },
      getPreferences: async () => ctx.prefsFile.read(),
      updatePreferences: async (patch) => ctx.prefsFile.update((p) => ({ ...p, ...patch }))
    },

    app: {
      info: async () => ({
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        userDataPath: ctx.paths.userData,
        logsPath: ctx.paths.logs,
        blobCachePath: ctx.paths.cache
      }),
      chooseFile: async (title, extensions) => {
        const r = await dialog.showOpenDialog(win()!, {
          title,
          properties: ['openFile'],
          filters: extensions.length
            ? [
                { name: extensions.join(', '), extensions },
                { name: 'All files', extensions: ['*'] }
              ]
            : undefined
        })
        return r.canceled ? undefined : r.filePaths[0]
      },
      chooseSaveFile: async (title, defaultName, extensions) => {
        const r = await dialog.showSaveDialog(win()!, {
          title,
          defaultPath: `${ctx.settings().downloadDir}/${defaultName}`,
          filters: extensions.length ? [{ name: extensions.join(', '), extensions }] : undefined
        })
        return r.canceled ? undefined : r.filePath
      },
      chooseDirectory: async (title) => {
        const r = await dialog.showOpenDialog(win()!, {
          title,
          properties: ['openDirectory', 'createDirectory']
        })
        return r.canceled ? undefined : r.filePaths[0]
      },
      showItemInFolder: async (path) => shell.showItemInFolder(path),
      openPath: async (path) => {
        // Only folders: opening arbitrary files could launch executables.
        if (!statSync(path).isDirectory()) throw new Error('Only folders can be opened')
        const err = await shell.openPath(path)
        if (err) throw new Error(err)
      },
      openLogs: async () => {
        await shell.openPath(ctx.paths.logs)
      },
      openExternal: async (url) => {
        if (!/^https:\/\//i.test(url)) throw new Error('Only https links can be opened')
        await shell.openExternal(url)
      },
      cacheStats: async () => ({ path: ctx.paths.cache, ...ctx.blobStore().stats() }),
      clearCache: async () => {
        const store = ctx.blobStore()
        store.clear()
        return { path: ctx.paths.cache, ...store.stats() }
      },
      copyText: async (text) => clipboard.writeText(text)
    }
  }

  for (const [ns, methods] of Object.entries(impl)) {
    for (const [method, fn] of Object.entries(
      methods as Record<string, (...a: unknown[]) => Promise<unknown>>
    )) {
      const channel = `${ns}.${method}`
      const schema = ipcSchemas[channel]
      if (!schema) throw new Error(`Missing IPC schema for ${channel}`)
      ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
        try {
          if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
          const parsed = schema.safeParse(trimUndefined(args))
          if (!parsed.success) {
            const issue = parsed.error.issues[0]
            throw new Error(issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'Invalid input')
          }
          if (!PUBLIC.has(channel) && !ctx.vault.isUnlocked())
            throw new VaultError('Vault is locked', 'LOCKED')
          currentEvent = event
          const data = await fn(...(parsed.data as unknown[]))
          return { ok: true, data }
        } catch (err) {
          const e = err as Error & { code?: string }
          if (channel !== 'vault.unlock') log.warn(`IPC ${channel} failed: ${e.message}`)
          return {
            ok: false,
            error: {
              message: e.message || String(err),
              code: typeof e.code === 'string' ? e.code : undefined
            }
          }
        }
      })
    }
  }
}

/** Only our own renderer (dev server or packaged file://) may call the API. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  if (url.startsWith('file://')) return true
  const dev = process.env.ELECTRON_RENDERER_URL
  return !!dev && url.startsWith(dev)
}

/** Drop trailing `undefined` arguments so optional parameters validate against the shorter tuple. */
function trimUndefined(args: unknown[]): unknown[] {
  const out = [...args]
  while (out.length && out[out.length - 1] === undefined) out.pop()
  return out
}
