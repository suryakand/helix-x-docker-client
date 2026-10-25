// End-to-end exercise of the main-process services (no Electron needed) against real registry:2
// containers and the local Docker engine. Run with `npm run test:integration`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Job, JobSpec } from '@helix/shared/types'
import { DockerService } from '../../src/docker/service'
import { RegistryService } from '../../src/registry/service'
import { defaultPreferences, defaultSettings } from '../../src/store/defaults'
import { RegistryStore } from '../../src/store/registries'
import { extractArchiveFile, readArchiveDir } from '../../src/transfer/archive'
import { JobManager } from '../../src/transfer/jobs'
import { Vault } from '../../src/vault/vault'

const env = process.env
const ANON = env.HELIX_IT_ANON
const AUTH = env.HELIX_IT_AUTH
const run = ANON && AUTH ? describe : describe.skip

run('registry integration', () => {
  const tmp = mkdtempSync(join(env.HELIX_IT_TMP!, 'work-'))
  const settings = { ...defaultSettings(tmp), blobCache: { enabled: true, maxSizeGb: 1 } }
  const prefs = defaultPreferences()
  const vault = new Vault(join(tmp, 'vault.json'), undefined, { memoryKiB: 1024, iterations: 1 })
  const store = new RegistryStore(join(tmp, 'registries.json'), vault)
  const registries = new RegistryService(
    store,
    () => settings,
    () => 100
  )
  const docker = new DockerService(
    () => '',
    join(tmp, 'loaded.json'),
    () => undefined
  )
  const finished = new Map<string, (j: Job) => void>()
  const jobs = new JobManager({
    registries,
    docker,
    settings: () => settings,
    preferences: () => prefs,
    cacheDir: join(tmp, 'cache'),
    tmpDir: tmp,
    historyPath: join(tmp, 'jobs.json'),
    emit: (j) => {
      if (['done', 'failed', 'cancelled'].includes(j.status)) finished.get(j.id)?.(j)
    },
    emitRemoved: () => undefined,
    log: () => undefined
  })
  const runJob = (spec: JobSpec) =>
    new Promise<Job>((resolve) => {
      const job = jobs.start(spec)
      finished.set(job.id, resolve)
    })

  let anonId = ''
  let authId = ''
  const tls = { insecureSkipVerify: false, plainHttp: true }

  beforeAll(async () => {
    await vault.setup('integration-password')
    anonId = store.create({
      config: { name: 'anon', type: 'generic', url: `http://${ANON}`, color: '#000', tls }
    }).id
    authId = store.create({
      config: { name: 'auth', type: 'generic', url: `http://${AUTH}`, color: '#000', tls },
      credentials: { username: env.HELIX_IT_USER!, password: env.HELIX_IT_PASS! }
    }).id
  })

  it('tests connections and rejects bad credentials', async () => {
    const ok = await registries.test({ id: authId, config: store.get(authId) })
    expect(ok.ok).toBe(true)
    expect(ok.auth).toBe('basic')
    const bad = await registries.test({
      config: store.get(authId),
      credentials: { username: 'helix', password: 'wrong' }
    })
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/Authentication failed/)
  })

  it('imports a docker save archive into a registry', async () => {
    const job = await runJob({
      kind: 'import',
      filePath: env.HELIX_IT_FIXTURE_TAR!,
      target: { registryId: anonId, repo: 'test/hello', ref: '1.0' }
    })
    expect(job.error).toBeUndefined()
    expect(job.status).toBe('done')
    const repos = await registries.listRepositories(anonId)
    expect(repos.items).toContain('test/hello')
    const tags = await registries.listTags(anonId, 'test/hello')
    expect(tags.items).toEqual(['1.0'])
    const details = await registries.imageDetails(anonId, 'test/hello', '1.0')
    expect(details.config.labels['org.opencontainers.image.title']).toBe('helix-x-integration')
    expect(details.layers).toHaveLength(1)
  })

  it('copies between registries (anonymous → basic auth) and retags / deletes', async () => {
    const job = await runJob({
      kind: 'copy',
      source: { registryId: anonId, repo: 'test/hello', ref: '1.0' },
      target: { registryId: authId, repo: 'test/hello', ref: 'copied' }
    })
    expect(job.error).toBeUndefined()
    const src = await registries.imageDetails(anonId, 'test/hello', '1.0')
    const dst = await registries.imageDetails(authId, 'test/hello', 'copied')
    expect(dst.manifestDigest).toBe(src.manifestDigest)

    await registries.retag(authId, 'test/hello', 'copied', 'to-delete')
    expect((await registries.listTags(authId, 'test/hello')).items.sort()).toEqual(['copied', 'to-delete'])
    // Same-registry copy uses a cross-repository mount.
    const mount = await runJob({
      kind: 'copy',
      source: { registryId: authId, repo: 'test/hello', ref: 'copied' },
      target: { registryId: authId, repo: 'other/hello', ref: 'mounted' }
    })
    expect(mount.error).toBeUndefined()
    expect((await registries.listTags(authId, 'other/hello')).items).toEqual(['mounted'])
  })

  it('deletes a manifest', async () => {
    await registries.deleteTag(anonId, 'test/hello', '1.0')
    await expect(registries.imageDetails(anonId, 'test/hello', '1.0')).rejects.toThrow(/Not found/)
  })

  it('exports to a tar that round-trips with the same digests', async () => {
    const filePath = join(tmp, 'export.tar')
    const job = await runJob({
      kind: 'export',
      source: { registryId: authId, repo: 'test/hello', ref: 'copied' },
      filePath
    })
    expect(job.error).toBeUndefined()
    const out = join(tmp, 'export-extracted')
    await extractArchiveFile(filePath, out)
    const archive = await readArchiveDir(out)
    const d = await registries.imageDetails(authId, 'test/hello', 'copied')
    const e = archive.entries[0]
    expect(e.kind === 'manifest' && e.digest).toBe(d.manifestDigest)
    expect(e.repoTags).toEqual([`${AUTH}/test/hello:copied`])
  })

  it('pulls into the local Docker engine without docker login', async () => {
    const status = await docker.status()
    expect(status.state).toBe('connected')
    const job = await runJob({
      kind: 'pull',
      source: { registryId: authId, repo: 'test/hello', ref: 'copied' },
      extraTag: 'helix-it/extra:tag'
    })
    expect(job.error).toBeUndefined()
    const inspect = JSON.parse(
      execFileSync('docker', ['image', 'inspect', `${AUTH}/test/hello:copied`], { encoding: 'utf8' })
    )
    expect(inspect[0].Config.Labels['org.opencontainers.image.title']).toBe('helix-x-integration')
    const images = await docker.listImages()
    expect(images.some((i) => i.pulledByApp && i.repoTags.includes(`${AUTH}/test/hello:copied`))).toBe(true)
    expect(images.some((i) => i.repoTags.includes('helix-it/extra:tag'))).toBe(true)
  })

  it('pushes a local Docker image to a registry', async () => {
    const job = await runJob({
      kind: 'push',
      localImage: env.HELIX_IT_FIXTURE_TAG!,
      target: { registryId: authId, repo: 'pushed/fixture', ref: 'v1' }
    })
    expect(job.error).toBeUndefined()
    const d = await registries.imageDetails(authId, 'pushed/fixture', 'v1')
    expect(d.config.labels['org.opencontainers.image.title']).toBe('helix-x-integration')
  })

  it('loads a tar into Docker and reports storage info', async () => {
    const job = await runJob({ kind: 'load', filePath: join(tmp, 'export.tar') })
    expect(job.error).toBeUndefined()
    const info = await docker.storageInfo()
    expect(info.dockerRootDir).toBeTruthy()
    expect(info.imagesCount).toBeGreaterThan(0)
  })
})
