import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { HardDrive, PackageOpen, RefreshCw, Trash2, Upload } from 'lucide-react'
import { Badge, Button, Empty, ErrorBox, Input, Spinner, Switch } from '../components/ui'
import { PageHeader } from '../components/PageHeader'
import { PushDialog, startJob } from '../components/ImageActions'
import { api, cn, formatBytes, formatDate, shortDigest } from '../lib/format'
import { confirmAction, useApp } from '../stores/app'

export function LocalImagesPage() {
  const docker = useApp((s) => s.docker)
  const prefs = useApp((s) => s.prefs)!
  const toast = useApp((s) => s.toast)
  const [filter, setFilter] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [push, setPush] = useState<string>()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const connected = docker?.state === 'connected'
  const q = useQuery({
    queryKey: ['local-images'],
    queryFn: () => api.docker.listImages(),
    enabled: connected,
    staleTime: 5_000
  })

  const images = useMemo(
    () =>
      (q.data ?? []).filter(
        (i) =>
          (!onlyMine || i.pulledByApp) &&
          `${i.repoTags.join(' ')} ${i.id}`.toLowerCase().includes(filter.toLowerCase())
      ),
    [q.data, filter, onlyMine]
  )

  const remove = async (id: string, label: string) => {
    const ok = await confirmAction({
      title: `Remove ${label}?`,
      message: 'The image is removed from the local Docker engine.',
      confirmLabel: 'Remove',
      danger: true
    })
    if (!ok) return
    try {
      await api.docker.removeImage(id, false)
      toast(`Removed ${label}`, 'success')
    } catch (err) {
      const msg = (err as Error).message
      if (/conflict|being used|must be forced|referenced in multiple/i.test(msg)) {
        const force = await useApp
          .getState()
          .ask({ title: 'Force remove?', message: msg, confirmLabel: 'Force remove', danger: true })
        if (force) await api.docker.removeImage(id, true).catch((e) => toast((e as Error).message, 'error'))
      } else toast(msg, 'error')
    }
    void qc.invalidateQueries({ queryKey: ['local-images'] })
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Local Images"
        subtitle={
          connected ? `Docker ${docker?.version} · ${docker?.endpoint}` : 'Images in your local Docker engine'
        }
        actions={
          <>
            <Button
              disabled={!connected}
              onClick={async () => {
                const f = await api.app.chooseFile('Load image archive into Docker', ['tar', 'gz', 'tgz'])
                if (f) await startJob({ kind: 'load', filePath: f }, () => navigate('/transfers'))
              }}
            >
              <PackageOpen className="size-4" /> Load .tar
            </Button>
            <Button onClick={() => q.refetch()} disabled={!connected}>
              <RefreshCw className={cn('size-4', q.isFetching && 'animate-spin')} />
            </Button>
          </>
        }
      />
      {!connected ? (
        <Empty
          icon={<HardDrive className="size-10" />}
          title={docker?.state === 'not-running' ? 'Docker is not running' : 'Docker engine not found'}
        >
          {docker?.message} — start Docker Desktop / the Docker daemon, or set a custom endpoint in Settings.
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-4 border-b border-border px-6 py-2.5">
            <Input
              className="h-8 max-w-sm"
              placeholder="Filter images"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <label className="flex items-center gap-2 text-xs text-muted">
              <Switch checked={onlyMine} onChange={setOnlyMine} /> Pulled via Helix-X Docker Client only
            </label>
            <span className="ml-auto text-xs text-muted">{images.length} images</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {q.isLoading && (
              <div className="p-6">
                <Spinner />
              </div>
            )}
            {q.error && (
              <div className="p-6">
                <ErrorBox error={q.error} />
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="px-6 py-2 font-medium">Repository : tag</th>
                  <th className="px-3 py-2 font-medium">Image ID</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {images.map((i) => {
                  const label = i.repoTags[0] ?? shortDigest(i.id)
                  return (
                    <tr key={i.id} className="border-b border-border hover:bg-panel-2">
                      <td className="px-6 py-2">
                        <div className="selectable space-y-0.5">
                          {(i.repoTags.length ? i.repoTags : ['<none>']).map((t) => (
                            <div key={t} className="flex items-center gap-2">
                              <span className="truncate">{t}</span>
                            </div>
                          ))}
                        </div>
                        {i.pulledByApp && (
                          <Badge tone="accent" className="mt-1">
                            Helix-X
                          </Badge>
                        )}
                      </td>
                      <td className="selectable px-3 py-2 font-mono text-xs text-muted">
                        {shortDigest(i.id)}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {formatDate(i.created, prefs.dateFormat)}
                      </td>
                      <td className="px-3 py-2 text-xs">{formatBytes(i.size, prefs.sizeUnits)}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" onClick={() => setPush(i.repoTags[0] ?? i.id)}>
                            <Upload className="size-3.5" /> Push
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => remove(i.id, label)}
                            title="Remove"
                          >
                            <Trash2 className="size-3.5 text-danger" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {push && <PushDialog localImage={push} onClose={() => setPush(undefined)} />}
    </div>
  )
}
