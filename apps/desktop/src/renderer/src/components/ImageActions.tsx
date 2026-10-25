import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { ImageDetails, JobSpec, Platform, RegistrySummary } from '@helix/shared/types'
import { api, errorMessage, platformLabel } from '../lib/format'
import { useRegistries } from '../lib/queries'
import { useApp } from '../stores/app'
import { Button, ErrorBox, Field, Input, Modal, Select, Switch } from './ui'

async function startJob(spec: JobSpec, navigateTo?: () => void) {
  const { toast, upsertJob } = useApp.getState()
  try {
    const job = await api.transfers.start(spec)
    upsertJob(job)
    toast(`Started: ${job.title}`)
    navigateTo?.()
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_')
}

export async function exportImage(registry: RegistrySummary, repo: string, tag: string, platform?: Platform) {
  const name = `${safeFileName(repo.split('/').pop() ?? repo)}_${safeFileName(tag)}${platform ? `_${safeFileName(platformLabel(platform))}` : ''}.tar`
  const filePath = await api.app.chooseSaveFile('Export image as .tar', name, ['tar'])
  if (!filePath) return
  await startJob({ kind: 'export', source: { registryId: registry.id, repo, ref: tag }, platform, filePath })
}

function PlatformSelect({
  details,
  value,
  onChange
}: {
  details: ImageDetails
  value?: string
  onChange: (v: string) => void
}) {
  if (details.platforms.length <= 1) return null
  return (
    <Field
      label="Platform"
      help="Multi-platform image: choose which variant to use. 'Auto' matches your Docker engine."
    >
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Auto</option>
        {details.platforms.map((p) => (
          <option key={platformLabel(p)} value={platformLabel(p)}>
            {platformLabel(p)}
          </option>
        ))}
      </Select>
    </Field>
  )
}

export function PullDialog({
  registry,
  repo,
  tag,
  details,
  onClose
}: {
  registry: RegistrySummary
  repo: string
  tag: string
  details: ImageDetails
  onClose: () => void
}) {
  const docker = useApp((s) => s.docker)
  const [platform, setPlatform] = useState<string>()
  const [extraTag, setExtraTag] = useState('')
  const navigate = useNavigate()
  const connected = docker?.state === 'connected'
  return (
    <Modal
      open
      onClose={onClose}
      title="Pull to Docker"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!connected}
            onClick={async () => {
              await startJob(
                {
                  kind: 'pull',
                  source: { registryId: registry.id, repo, ref: tag },
                  platform: details.platforms.find((p) => platformLabel(p) === platform),
                  extraTag: extraTag.trim() || undefined
                },
                () => navigate('/transfers')
              )
              onClose()
            }}
          >
            Pull
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Helix-X Docker Client downloads{' '}
          <b className="text-fg">
            {repo}:{tag}
          </b>{' '}
          with the credentials saved for <b className="text-fg">{registry.name}</b> and loads it into your
          local Docker engine. No <code>docker login</code> is needed.
        </p>
        {!connected && (
          <ErrorBox
            error={`Docker is not available (${docker?.message ?? docker?.state ?? 'unknown'}). Start Docker, or use Export .tar instead.`}
          />
        )}
        <PlatformSelect details={details} value={platform} onChange={setPlatform} />
        <Field
          label="Additional local tag (optional)"
          help="e.g. myapp:dev — in addition to the full registry name."
        >
          <Input value={extraTag} onChange={(e) => setExtraTag(e.target.value)} placeholder="myapp:dev" />
        </Field>
      </div>
    </Modal>
  )
}

export function CopyDialog({
  registry,
  repo,
  tag,
  details,
  onClose
}: {
  registry: RegistrySummary
  repo: string
  tag: string
  details: ImageDetails
  onClose: () => void
}) {
  const { data: registries = [] } = useRegistries()
  const [target, setTarget] = useState(registries.find((r) => r.id !== registry.id)?.id ?? registry.id)
  const [targetRepo, setTargetRepo] = useState(repo.replace(/^library\//, ''))
  const [targetTag, setTargetTag] = useState(tag)
  const [allPlatforms, setAllPlatforms] = useState(details.isIndex)
  const [platform, setPlatform] = useState<string>()
  const navigate = useNavigate()
  return (
    <Modal
      open
      onClose={onClose}
      title="Copy image to another registry"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!targetRepo.trim() || !targetTag.trim()}
            onClick={async () => {
              await startJob(
                {
                  kind: 'copy',
                  source: { registryId: registry.id, repo, ref: tag },
                  target: { registryId: target, repo: targetRepo.trim(), ref: targetTag.trim() },
                  allPlatforms,
                  platform: allPlatforms
                    ? undefined
                    : details.platforms.find((p) => platformLabel(p) === platform)
                },
                () => navigate('/transfers')
              )
              onClose()
            }}
          >
            Copy
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Target registry">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            {registries.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — {r.url}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_160px] gap-3">
          <Field label="Repository">
            <Input value={targetRepo} onChange={(e) => setTargetRepo(e.target.value)} />
          </Field>
          <Field label="Tag">
            <Input value={targetTag} onChange={(e) => setTargetTag(e.target.value)} />
          </Field>
        </div>
        {details.isIndex && (
          <div className="flex items-center justify-between text-sm">
            <span>Copy all platforms ({details.platforms.length})</span>
            <Switch checked={allPlatforms} onChange={setAllPlatforms} />
          </div>
        )}
        {!allPlatforms && <PlatformSelect details={details} value={platform} onChange={setPlatform} />}
      </div>
    </Modal>
  )
}

export function RetagDialog({
  registry,
  repo,
  tag,
  onClose
}: {
  registry: RegistrySummary
  repo: string
  tag: string
  onClose: () => void
}) {
  const [newTag, setNewTag] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const toast = useApp((s) => s.toast)
  return (
    <Modal
      open
      onClose={onClose}
      title={`Add tag to ${repo}:${tag}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!newTag.trim()}
            onClick={async () => {
              setBusy(true)
              setError(undefined)
              try {
                await api.explorer.retag(registry.id, repo, tag, newTag.trim())
                toast(`Tagged ${repo}:${newTag.trim()}`, 'success')
                await qc.invalidateQueries({ queryKey: ['tags', registry.id, repo] })
                onClose()
              } catch (err) {
                setError(errorMessage(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            Create tag
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="New tag" help="The same manifest is published under this tag; no layers are copied.">
          <Input autoFocus value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="v1.2.3" />
        </Field>
        {error && <ErrorBox error={error} />}
      </div>
    </Modal>
  )
}

export function ImportDialog({
  registry,
  defaultRepo,
  onClose
}: {
  registry: RegistrySummary
  defaultRepo?: string
  onClose: () => void
}) {
  const [file, setFile] = useState<string>()
  const [repo, setRepo] = useState(defaultRepo ?? '')
  const [tag, setTag] = useState('latest')
  const navigate = useNavigate()
  return (
    <Modal
      open
      onClose={onClose}
      title={`Import .tar into ${registry.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!file || !repo.trim() || !tag.trim()}
            onClick={async () => {
              await startJob(
                {
                  kind: 'import',
                  filePath: file!,
                  target: { registryId: registry.id, repo: repo.trim(), ref: tag.trim() }
                },
                () => navigate('/transfers')
              )
              onClose()
            }}
          >
            Import & push
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Image archive"
          help="docker save output (.tar / .tar.gz) or an OCI image layout tarball."
        >
          <div className="flex gap-2">
            <Input readOnly value={file ?? ''} placeholder="No file selected" />
            <Button
              onClick={async () =>
                setFile((await api.app.chooseFile('Select image archive', ['tar', 'gz', 'tgz'])) ?? file)
              }
            >
              Browse…
            </Button>
          </div>
        </Field>
        <div className="grid grid-cols-[1fr_160px] gap-3">
          <Field label="Target repository">
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="team/app" />
          </Field>
          <Field label="Tag">
            <Input value={tag} onChange={(e) => setTag(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

export function PushDialog({ localImage, onClose }: { localImage: string; onClose: () => void }) {
  const { data: registries = [] } = useRegistries()
  const activeId = useApp((s) => s.activeRegistryId)
  const [target, setTarget] = useState(activeId ?? registries[0]?.id ?? '')
  const name = localImage.replace(/^[^/]+\.[^/]+\//, '').replace(/^[^/]*:\d+\//, '')
  const idx = name.lastIndexOf(':')
  const [repo, setRepo] = useState(idx > 0 ? name.slice(0, idx) : name)
  const [tag, setTag] = useState(idx > 0 ? name.slice(idx + 1) : 'latest')
  const navigate = useNavigate()
  return (
    <Modal
      open
      onClose={onClose}
      title={`Push ${localImage}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!target || !repo.trim() || !tag.trim()}
            onClick={async () => {
              await startJob(
                {
                  kind: 'push',
                  localImage,
                  target: { registryId: target, repo: repo.trim(), ref: tag.trim() }
                },
                () => navigate('/transfers')
              )
              onClose()
            }}
          >
            Push
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          The image is exported from Docker and pushed with the credentials saved in Helix-X Docker Client.
        </p>
        <Field label="Target registry">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            {registries.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — {r.url}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_160px] gap-3">
          <Field label="Repository">
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} />
          </Field>
          <Field label="Tag">
            <Input value={tag} onChange={(e) => setTag(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

export { startJob }
