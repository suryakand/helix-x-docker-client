// Runtime validation for every IPC call. Keys are "<namespace>.<method>", values validate the argument tuple.
import { z } from 'zod'

const id = z.string().min(1).max(200)
const repo = z.string().min(1).max(512)
const ref = z.string().min(1).max(256)
const shortText = z.string().max(2048)

export const platformSchema = z.object({
  os: z.string().max(64),
  architecture: z.string().max(64),
  variant: z.string().max(64).optional()
})

export const registryTypeSchema = z.enum([
  'generic',
  'dockerhub',
  'harbor',
  'nexus',
  'artifactory',
  'ecr',
  'gcr',
  'acr',
  'ghcr',
  'gitlab'
])

export const registryInputSchema = z.object({
  id: id.optional(),
  config: z.object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    type: registryTypeSchema,
    url: z.string().trim().min(1, 'URL is required').max(512),
    namespace: z.string().trim().max(256).optional(),
    region: z.string().trim().max(64).optional(),
    apiUrl: z.string().trim().max(512).optional(),
    color: z.string().max(32),
    tls: z.object({
      insecureSkipVerify: z.boolean(),
      plainHttp: z.boolean(),
      caFile: z.string().max(1024).optional()
    }),
    pinnedRepos: z.array(repo).max(500).optional()
  }),
  credentials: z.record(z.string().max(64), z.string().max(65536)).optional()
})

const imageRef = z.object({ registryId: id, repo, ref })

export const jobSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pull'),
    source: imageRef,
    platform: platformSchema.optional(),
    extraTag: z.string().max(256).optional()
  }),
  z.object({
    kind: z.literal('export'),
    source: imageRef,
    platform: platformSchema.optional(),
    filePath: z.string().min(1).max(4096)
  }),
  z.object({ kind: z.literal('import'), filePath: z.string().min(1).max(4096), target: imageRef }),
  z.object({ kind: z.literal('push'), localImage: z.string().min(1).max(512), target: imageRef }),
  z.object({
    kind: z.literal('copy'),
    source: imageRef,
    platform: platformSchema.optional(),
    allPlatforms: z.boolean().optional(),
    target: imageRef
  }),
  z.object({ kind: z.literal('load'), filePath: z.string().min(1).max(4096) })
])

export const settingsPatchSchema = z
  .object({
    autoLockMinutes: z.number().int().min(0).max(1440),
    lockOnSleep: z.boolean(),
    proxy: z.object({
      mode: z.enum(['system', 'none', 'manual']),
      url: z.string().max(1024),
      noProxy: z.string().max(2048)
    }),
    caFiles: z.array(z.string().max(4096)).max(50),
    downloadDir: z.string().max(4096),
    jobConcurrency: z.number().int().min(1).max(8),
    blobConcurrency: z.number().int().min(1).max(16),
    requestTimeoutSec: z.number().int().min(5).max(3600),
    logLevel: z.enum(['error', 'warn', 'info', 'debug']),
    dockerHost: z.string().max(1024),
    blobCache: z.object({ enabled: z.boolean(), maxSizeGb: z.number().min(0.5).max(1024) }),
    allowDeletes: z.boolean()
  })
  .partial()

export const preferencesPatchSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    density: z.enum(['comfortable', 'compact']),
    language: z.enum(['en']),
    startupPage: z.enum(['explorer', 'registries', 'local', 'transfers']),
    dateFormat: z.enum(['relative', 'absolute']),
    sizeUnits: z.enum(['si', 'iec']),
    confirmDeletes: z.boolean(),
    defaultPlatform: z.string().max(64),
    localTagStyle: z.enum(['full', 'short']),
    pageSize: z.number().int().min(10).max(1000)
  })
  .partial()

const none = z.tuple([])
const password = z.string().min(1).max(1024)

export const ipcSchemas: Record<string, z.ZodType<unknown[]>> = {
  'vault.status': none,
  'vault.setup': z.tuple([z.string().min(8, 'Use at least 8 characters').max(1024)]),
  'vault.unlock': z.tuple([password]),
  'vault.unlockWithKeychain': none,
  'vault.lock': none,
  'vault.changePassword': z.tuple([password, z.string().min(8, 'Use at least 8 characters').max(1024)]),
  'vault.setKeychainUnlock': z.tuple([z.boolean()]),
  'vault.reset': none,

  'registries.list': none,
  'registries.create': z.tuple([registryInputSchema]),
  'registries.update': z.tuple([id, registryInputSchema]),
  'registries.remove': z.tuple([id]),
  'registries.duplicate': z.tuple([id]),
  'registries.setDefault': z.tuple([id]),
  'registries.setPinned': z.tuple([id, z.array(repo).max(500)]),
  'registries.test': z.tuple([registryInputSchema]),
  'registries.exportConfigs': z.union([
    z.tuple([z.boolean()]),
    z.tuple([z.boolean(), z.string().max(1024).optional()])
  ]),
  'registries.importConfigs': z.union([z.tuple([]), z.tuple([z.string().max(1024).optional()])]),
  'registries.scanDockerLogins': none,
  'registries.importDockerLogins': z.tuple([z.array(z.string().min(1).max(512)).max(200)]),

  'explorer.listRepositories': z.union([z.tuple([id]), z.tuple([id, shortText.optional()])]),
  'explorer.listTags': z.union([z.tuple([id, repo]), z.tuple([id, repo, shortText.optional()])]),
  'explorer.tagSummary': z.tuple([id, repo, ref]),
  'explorer.imageDetails': z.union([
    z.tuple([id, repo, ref]),
    z.tuple([id, repo, ref, platformSchema.optional()])
  ]),
  'explorer.deleteTag': z.tuple([id, repo, ref]),
  'explorer.retag': z.tuple([id, repo, ref, z.string().regex(/^[\w][\w.-]{0,127}$/, 'Invalid tag')]),

  'docker.status': none,
  'docker.storageInfo': none,
  'docker.listImages': none,
  'docker.removeImage': z.tuple([z.string().min(1).max(512), z.boolean()]),

  'transfers.list': none,
  'transfers.start': z.tuple([jobSpecSchema]),
  'transfers.cancel': z.tuple([id]),
  'transfers.retry': z.tuple([id]),
  'transfers.clearFinished': none,

  'settings.get': none,
  'settings.update': z.tuple([settingsPatchSchema]),
  'settings.getPreferences': none,
  'settings.updatePreferences': z.tuple([preferencesPatchSchema]),

  'app.info': none,
  'app.chooseFile': z.tuple([shortText, z.array(z.string().max(16)).max(20)]),
  'app.chooseSaveFile': z.tuple([shortText, shortText, z.array(z.string().max(16)).max(20)]),
  'app.chooseDirectory': z.tuple([shortText]),
  'app.showItemInFolder': z.tuple([z.string().min(1).max(4096)]),
  'app.openPath': z.tuple([z.string().min(1).max(4096)]),
  'app.openLogs': none,
  'app.openExternal': z.tuple([z.string().url().max(2048)]),
  'app.cacheStats': none,
  'app.clearCache': none,
  'app.copyText': z.tuple([z.string().max(1_000_000)])
}
