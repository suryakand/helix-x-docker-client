// Types shared by the main process, preload bridge and renderer.

export type RegistryType =
  'generic' | 'dockerhub' | 'harbor' | 'nexus' | 'artifactory' | 'ecr' | 'gcr' | 'acr' | 'ghcr' | 'gitlab'

export interface RegistryTls {
  /** Accept self-signed / invalid certificates. */
  insecureSkipVerify: boolean
  /** Talk plain HTTP instead of HTTPS (local / lab registries). */
  plainHttp: boolean
  /** Optional PEM file with an additional CA certificate for this registry. */
  caFile?: string
}

export interface RegistryConfig {
  id: string
  name: string
  type: RegistryType
  /** Registry host URL, e.g. https://registry.example.com */
  url: string
  /** Namespace / org / project / group used for repository listing (provider specific). */
  namespace?: string
  /** AWS region (ECR). */
  region?: string
  /** Provider REST API base URL override (GitLab / Harbor). */
  apiUrl?: string
  color: string
  tls: RegistryTls
  isDefault: boolean
  /** Repositories the user opened manually or pinned (helps when listing is not allowed). */
  pinnedRepos: string[]
  createdAt: string
  updatedAt: string
}

/** Registry config as seen by the renderer: secrets are never returned, only whether they exist. */
export interface RegistrySummary extends RegistryConfig {
  hasCredentials: boolean
  credentialHints: Record<string, string>
}

/** Secret fields keyed by the provider's credential field keys. */
export type RegistryCredentials = Record<string, string>

export interface RegistryInput {
  config: Omit<RegistryConfig, 'id' | 'createdAt' | 'updatedAt' | 'isDefault' | 'pinnedRepos'> & {
    pinnedRepos?: string[]
  }
  /** Omitted on update = keep existing secrets. Empty string for a field = clear that field. */
  credentials?: RegistryCredentials
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  latencyMs: number
  auth: 'anonymous' | 'basic' | 'bearer' | 'unknown'
  canList: boolean
}

export interface Page<T> {
  items: T[]
  /** Opaque cursor for the next page, absent when there are no more items. */
  next?: string
  /** True when the provider does not allow listing; the UI then offers manual repository entry. */
  listingUnsupported?: boolean
  message?: string
}

export interface Platform {
  os: string
  architecture: string
  variant?: string
}

export interface Descriptor {
  mediaType: string
  digest: string
  size: number
  platform?: Platform
  annotations?: Record<string, string>
}

export interface TagSummary {
  tag: string
  digest: string
  mediaType: string
  size: number
  created?: string
  platforms: Platform[]
}

export interface ImageConfigSummary {
  created?: string
  architecture?: string
  os?: string
  variant?: string
  author?: string
  user?: string
  workingDir?: string
  env: string[]
  entrypoint: string[]
  cmd: string[]
  exposedPorts: string[]
  volumes: string[]
  labels: Record<string, string>
  history: { created?: string; createdBy?: string; comment?: string; emptyLayer?: boolean }[]
}

export interface ImageDetails {
  registryId: string
  repo: string
  ref: string
  /** Digest of what `ref` points to (an index for multi-arch images). */
  digest: string
  mediaType: string
  isIndex: boolean
  platforms: Platform[]
  selectedPlatform?: Platform
  /** Digest of the platform specific manifest that was resolved. */
  manifestDigest: string
  config: ImageConfigSummary
  configDigest: string
  layers: Descriptor[]
  totalSize: number
  rawManifest: string
  rawIndex?: string
  rawConfig: string
  pullCommand: string
}

// ---------------------------------------------------------------- vault

export interface VaultStatus {
  initialized: boolean
  unlocked: boolean
  keychainAvailable: boolean
  keychainEnabled: boolean
  biometricAvailable: boolean
  /** Seconds the user must wait before the next unlock attempt. */
  retryAfterSec: number
}

// ---------------------------------------------------------------- local docker

export type DockerState = 'connected' | 'not-running' | 'not-found' | 'error'

export interface DockerStatus {
  state: DockerState
  endpoint: string
  endpointSource: 'settings' | 'DOCKER_HOST' | 'context' | 'default' | 'none'
  contextName?: string
  version?: string
  apiVersion?: string
  os?: string
  arch?: string
  message?: string
}

export interface DockerStorageInfo {
  status: DockerStatus
  engineName: string
  operatingSystem?: string
  dockerRootDir?: string
  storageDriver?: string
  containerdSnapshotter: boolean
  /** Host path of the VM disk image that holds DockerRootDir (Docker Desktop / VM based engines). */
  vmDiskPath?: string
  vmDiskExists: boolean
  vmDiskSizeBytes?: number
  /** True when dockerRootDir is directly on this machine's filesystem (native Linux engine). */
  rootDirOnHost: boolean
  imagesCount?: number
  imagesSizeBytes?: number
  notes: string[]
}

export interface LocalImage {
  id: string
  repoTags: string[]
  repoDigests: string[]
  created: number
  size: number
  labels: Record<string, string>
  pulledByApp: boolean
}

// ---------------------------------------------------------------- transfers

export type JobKind = 'pull' | 'export' | 'import' | 'push' | 'copy' | 'load'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ImageRef {
  registryId: string
  repo: string
  ref: string
}

export type JobSpec =
  | { kind: 'pull'; source: ImageRef; platform?: Platform; extraTag?: string }
  | { kind: 'export'; source: ImageRef; platform?: Platform; filePath: string }
  | { kind: 'import'; filePath: string; target: ImageRef }
  | { kind: 'push'; localImage: string; target: ImageRef }
  | { kind: 'copy'; source: ImageRef; platform?: Platform; allPlatforms?: boolean; target: ImageRef }
  | { kind: 'load'; filePath: string }

export interface Job {
  id: string
  kind: JobKind
  title: string
  spec: JobSpec
  status: JobStatus
  phase: string
  bytesDone: number
  bytesTotal: number
  error?: string
  result?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

// ---------------------------------------------------------------- settings & preferences

export interface Settings {
  autoLockMinutes: number
  lockOnSleep: boolean
  proxy: { mode: 'system' | 'none' | 'manual'; url: string; noProxy: string }
  caFiles: string[]
  downloadDir: string
  jobConcurrency: number
  blobConcurrency: number
  requestTimeoutSec: number
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  /** Docker endpoint override, e.g. unix:///var/run/docker.sock, npipe:////./pipe/docker_engine, tcp://host:2375 */
  dockerHost: string
  blobCache: { enabled: boolean; maxSizeGb: number }
  allowDeletes: boolean
}

export interface Preferences {
  theme: 'system' | 'light' | 'dark'
  density: 'comfortable' | 'compact'
  language: 'en'
  startupPage: 'explorer' | 'registries' | 'local' | 'transfers'
  dateFormat: 'relative' | 'absolute'
  sizeUnits: 'si' | 'iec'
  confirmDeletes: boolean
  /** 'auto' = match the local Docker engine's os/arch. Otherwise "os/arch[/variant]". */
  defaultPlatform: string
  /** How images pulled into Docker are tagged. */
  localTagStyle: 'full' | 'short'
  pageSize: number
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  userDataPath: string
  logsPath: string
  blobCachePath: string
}

export interface CacheStats {
  path: string
  sizeBytes: number
  blobs: number
}

export interface ConfigBackupResult {
  path?: string
  count: number
}

/** A `docker login` entry found in ~/.docker/config.json (secrets stay in the main process). */
export interface DockerLoginCandidate {
  /** Server key as written by docker, e.g. https://index.docker.io/v1/ or ghcr.io */
  server: string
  username: string
  /** Where the secret lives: "config.json" or "helper: osxkeychain" … */
  source: string
  type: RegistryType
  url: string
  /** False when the stored credential cannot be used long-term (e.g. ECR 12h tokens). */
  supported: boolean
  alreadyAdded: boolean
  note?: string
}

export interface DockerLoginScan {
  configPath: string
  candidates: DockerLoginCandidate[]
  /** Non-fatal problems, e.g. a credential helper that is not installed. */
  warnings: string[]
}

export type AppEvent =
  | { type: 'vault'; status: VaultStatus }
  | { type: 'job'; job: Job }
  | { type: 'job-removed'; id: string }
  | { type: 'docker'; status: DockerStatus }
  | { type: 'registries-changed' }
  /** Ask the renderer to show a route, e.g. from the native Help menu or a notification click. */
  | { type: 'navigate'; path: string }
