import { FolderSearch, HardDrive, RefreshCw } from 'lucide-react'
import type { Preferences } from '@helix/shared/types'
import { Badge, Button, Card, Row, Select, Spinner, Switch } from '../components/ui'
import { PageHeader } from '../components/PageHeader'
import { api, cn, errorMessage, formatBytes } from '../lib/format'
import { useDockerStorage } from '../lib/queries'
import { useApp } from '../stores/app'

const PLATFORMS = [
  'auto',
  'linux/amd64',
  'linux/arm64',
  'linux/arm/v7',
  'linux/386',
  'linux/ppc64le',
  'linux/s390x',
  'windows/amd64'
]

export function PreferencesPage() {
  const prefs = useApp((s) => s.prefs)!
  const setPrefs = useApp((s) => s.setPrefs)
  const toast = useApp((s) => s.toast)
  const update = async (patch: Partial<Preferences>) => {
    setPrefs({ ...prefs, ...patch })
    try {
      setPrefs(await api.settings.updatePreferences(patch))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Preferences" subtitle="Where images go, and how the app looks and behaves." />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="space-y-5">
          <DockerStorageCard />

          <Card title="Pulling images">
            <div className="divide-y divide-border">
              <Row
                label="Default platform"
                description="For multi-platform images. Auto matches the local Docker engine."
              >
                <Select
                  className="w-56"
                  value={prefs.defaultPlatform}
                  onChange={(e) => update({ defaultPlatform: e.target.value })}
                >
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p === 'auto' ? 'Auto (match Docker)' : p}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label="Local image name" description="How pulled images are tagged in Docker.">
                <Select
                  className="w-56"
                  value={prefs.localTagStyle}
                  onChange={(e) => update({ localTagStyle: e.target.value as Preferences['localTagStyle'] })}
                >
                  <option value="full">registry.host/repo:tag</option>
                  <option value="short">repo:tag</option>
                </Select>
              </Row>
            </div>
          </Card>

          <Card title="Appearance">
            <div className="divide-y divide-border">
              <Row label="Theme">
                <Select
                  className="w-56"
                  value={prefs.theme}
                  onChange={(e) => update({ theme: e.target.value as Preferences['theme'] })}
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </Select>
              </Row>
              <Row label="Density">
                <Select
                  className="w-56"
                  value={prefs.density}
                  onChange={(e) => update({ density: e.target.value as Preferences['density'] })}
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </Select>
              </Row>
              <Row label="Language">
                <Select
                  className="w-56"
                  value={prefs.language}
                  onChange={(e) => update({ language: e.target.value as Preferences['language'] })}
                >
                  <option value="en">English</option>
                </Select>
              </Row>
              <Row label="Dates">
                <Select
                  className="w-56"
                  value={prefs.dateFormat}
                  onChange={(e) => update({ dateFormat: e.target.value as Preferences['dateFormat'] })}
                >
                  <option value="relative">Relative (2 days ago)</option>
                  <option value="absolute">Absolute</option>
                </Select>
              </Row>
              <Row label="Sizes">
                <Select
                  className="w-56"
                  value={prefs.sizeUnits}
                  onChange={(e) => update({ sizeUnits: e.target.value as Preferences['sizeUnits'] })}
                >
                  <option value="si">Decimal (MB)</option>
                  <option value="iec">Binary (MiB)</option>
                </Select>
              </Row>
            </div>
          </Card>

          <Card title="Behaviour">
            <div className="divide-y divide-border">
              <Row label="Start on">
                <Select
                  className="w-56"
                  value={prefs.startupPage}
                  onChange={(e) => update({ startupPage: e.target.value as Preferences['startupPage'] })}
                >
                  <option value="explorer">Explorer</option>
                  <option value="registries">Registries</option>
                  <option value="local">Local Images</option>
                  <option value="transfers">Transfers</option>
                </Select>
              </Row>
              <Row label="Items per page" description="Repositories and tags fetched per request.">
                <Select
                  className="w-56"
                  value={prefs.pageSize}
                  onChange={(e) => update({ pageSize: Number(e.target.value) })}
                >
                  {[50, 100, 250, 500, 1000].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </Row>
              <Row label="Confirm before deleting">
                <Switch checked={prefs.confirmDeletes} onChange={(v) => update({ confirmDeletes: v })} />
              </Row>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function DockerStorageCard() {
  const q = useDockerStorage()
  const s = q.data
  const connected = s?.status.state === 'connected'
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <HardDrive className="size-4" /> Docker image storage
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} title="Refresh">
          <RefreshCw className={cn('size-3.5', q.isFetching && 'animate-spin')} />
        </Button>
      }
    >
      {q.isLoading && <Spinner />}
      {s && (
        <div className="space-y-3 py-2 text-sm">
          <p className="text-muted">
            Images pulled with Helix-X Docker Client are stored by your local Docker engine, in the same place
            as images from <code>docker pull</code>.
          </p>
          <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted">Engine</dt>
            <dd className="flex items-center gap-2">
              {s.engineName}
              <Badge tone={connected ? 'ok' : 'warn'}>
                {connected ? `running · ${s.status.version}` : s.status.state}
              </Badge>
            </dd>
            {s.operatingSystem && (
              <>
                <dt className="text-muted">Engine OS</dt>
                <dd>{s.operatingSystem}</dd>
              </>
            )}
            <dt className="text-muted">Endpoint</dt>
            <dd className="selectable font-mono text-xs break-all">
              {s.status.endpoint}
              {s.status.contextName && (
                <span className="ml-2 font-sans text-muted">(context: {s.status.contextName})</span>
              )}
            </dd>
            <dt className="text-muted">Docker root dir</dt>
            <dd className="selectable flex items-center gap-2 font-mono text-xs break-all">
              {s.dockerRootDir ?? '—'}
              {s.dockerRootDir && !s.rootDirOnHost && <Badge>inside VM</Badge>}
            </dd>
            {s.storageDriver && (
              <>
                <dt className="text-muted">Storage driver</dt>
                <dd>{s.storageDriver}</dd>
              </>
            )}
            {s.vmDiskPath && (
              <>
                <dt className="text-muted">On this computer</dt>
                <dd className="space-y-1">
                  <div className="selectable font-mono text-xs break-all">{s.vmDiskPath}</div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    {s.vmDiskExists
                      ? `VM disk image · ${formatBytes(s.vmDiskSizeBytes)} used`
                      : 'Not found at the default location'}
                    {s.vmDiskExists && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => api.app.showItemInFolder(s.vmDiskPath!)}
                      >
                        <FolderSearch className="size-3.5" /> Reveal
                      </Button>
                    )}
                  </div>
                </dd>
              </>
            )}
            {s.rootDirOnHost && s.dockerRootDir && (
              <>
                <dt className="text-muted">On this computer</dt>
                <dd>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => api.app.showItemInFolder(s.dockerRootDir!)}
                  >
                    <FolderSearch className="size-3.5" /> Reveal {s.dockerRootDir}
                  </Button>
                </dd>
              </>
            )}
            {s.imagesCount !== undefined && (
              <>
                <dt className="text-muted">Images</dt>
                <dd>
                  {s.imagesCount} images
                  {s.imagesSizeBytes !== undefined && ` · ${formatBytes(s.imagesSizeBytes)}`}
                </dd>
              </>
            )}
          </dl>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
            {s.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
