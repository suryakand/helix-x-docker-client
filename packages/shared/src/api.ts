// The typed API that the preload script exposes to the renderer as `window.helix`.
// Every method maps to the IPC channel "<namespace>.<method>" and is validated in the main process
// against the zod schemas in ./schemas.ts.
import type {
  AppEvent,
  AppInfo,
  CacheStats,
  ConfigBackupResult,
  DockerLoginScan,
  DockerStatus,
  DockerStorageInfo,
  ImageDetails,
  Job,
  JobSpec,
  LocalImage,
  Page,
  Platform,
  Preferences,
  RegistryInput,
  RegistrySummary,
  Settings,
  TagSummary,
  TestConnectionResult,
  VaultStatus
} from './types'

export interface HelixApi {
  vault: {
    status(): Promise<VaultStatus>
    setup(password: string): Promise<VaultStatus>
    unlock(password: string): Promise<VaultStatus>
    unlockWithKeychain(): Promise<VaultStatus>
    lock(): Promise<VaultStatus>
    changePassword(current: string, next: string): Promise<VaultStatus>
    setKeychainUnlock(enabled: boolean): Promise<VaultStatus>
    reset(): Promise<VaultStatus>
  }
  registries: {
    list(): Promise<RegistrySummary[]>
    create(input: RegistryInput): Promise<RegistrySummary>
    update(id: string, input: RegistryInput): Promise<RegistrySummary>
    remove(id: string): Promise<void>
    duplicate(id: string): Promise<RegistrySummary>
    setDefault(id: string): Promise<void>
    setPinned(id: string, repos: string[]): Promise<void>
    /** Test a saved registry (id) or an unsaved draft (input; may include an id to reuse stored secrets). */
    test(input: RegistryInput & { id?: string }): Promise<TestConnectionResult>
    exportConfigs(includeSecrets: boolean, passphrase?: string): Promise<ConfigBackupResult>
    importConfigs(passphrase?: string): Promise<ConfigBackupResult>
    /** Find registries you are already logged in to with `docker login`. */
    scanDockerLogins(): Promise<DockerLoginScan>
    /** Create registries for the selected `docker login` entries (by server key). */
    importDockerLogins(servers: string[]): Promise<ConfigBackupResult>
  }
  explorer: {
    listRepositories(registryId: string, cursor?: string): Promise<Page<string>>
    listTags(registryId: string, repo: string, cursor?: string): Promise<Page<string>>
    tagSummary(registryId: string, repo: string, tag: string): Promise<TagSummary>
    imageDetails(registryId: string, repo: string, ref: string, platform?: Platform): Promise<ImageDetails>
    deleteTag(registryId: string, repo: string, ref: string): Promise<void>
    retag(registryId: string, repo: string, ref: string, newTag: string): Promise<void>
  }
  docker: {
    status(): Promise<DockerStatus>
    storageInfo(): Promise<DockerStorageInfo>
    listImages(): Promise<LocalImage[]>
    removeImage(id: string, force: boolean): Promise<void>
  }
  transfers: {
    list(): Promise<Job[]>
    start(spec: JobSpec): Promise<Job>
    cancel(id: string): Promise<void>
    retry(id: string): Promise<Job>
    clearFinished(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    getPreferences(): Promise<Preferences>
    updatePreferences(patch: Partial<Preferences>): Promise<Preferences>
  }
  app: {
    info(): Promise<AppInfo>
    chooseFile(title: string, extensions: string[]): Promise<string | undefined>
    chooseSaveFile(title: string, defaultName: string, extensions: string[]): Promise<string | undefined>
    chooseDirectory(title: string): Promise<string | undefined>
    showItemInFolder(path: string): Promise<void>
    openPath(path: string): Promise<void>
    openLogs(): Promise<void>
    openExternal(url: string): Promise<void>
    cacheStats(): Promise<CacheStats>
    clearCache(): Promise<CacheStats>
    copyText(text: string): Promise<void>
  }
}

export type ApiNamespace = keyof HelixApi

export interface HelixBridge extends HelixApi {
  onEvent(listener: (event: AppEvent) => void): () => void
}

export const EVENT_CHANNEL = 'helix:event'

/** Result envelope used on the wire so errors arrive in the renderer with a clean message. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { message: string; code?: string } }
