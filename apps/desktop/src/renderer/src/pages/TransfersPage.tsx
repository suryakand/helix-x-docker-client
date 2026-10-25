import { useMemo } from 'react'
import {
  ArrowLeftRight,
  CheckCircle2,
  CircleSlash,
  FolderOpen,
  Loader2,
  RotateCcw,
  X,
  XCircle
} from 'lucide-react'
import type { Job } from '@helix/shared/types'
import { Badge, Button, Empty, Progress } from '../components/ui'
import { PageHeader } from '../components/PageHeader'
import { api, formatBytes, formatDate } from '../lib/format'
import { useApp } from '../stores/app'

const KIND_LABEL: Record<Job['kind'], string> = {
  pull: 'Pull to Docker',
  export: 'Export',
  import: 'Import',
  push: 'Push',
  copy: 'Copy',
  load: 'Load'
}

export function TransfersPage() {
  const jobs = useApp((s) => s.jobs)
  const prefs = useApp((s) => s.prefs)!
  const list = useMemo(
    () => Object.values(jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [jobs]
  )
  const finished = list.some((j) => j.status !== 'running' && j.status !== 'queued')

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Transfers"
        subtitle="Pulls, exports, imports, pushes and copies run in the background."
        actions={
          <Button disabled={!finished} onClick={() => api.transfers.clearFinished()}>
            Clear finished
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {!list.length ? (
          <Empty icon={<ArrowLeftRight className="size-10" />} title="No transfers yet">
            Pull an image to Docker, export it to a .tar file or copy it between registries from the Explorer.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {list.map((j) => (
              <li key={j.id} className="rounded-lg border border-border bg-panel p-4">
                <div className="flex items-start gap-3">
                  <StatusIcon status={j.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge>{KIND_LABEL[j.kind]}</Badge>
                      <span className="selectable truncate text-sm font-medium" title={j.title}>
                        {j.title}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                      <span>{j.phase}</span>
                      {j.bytesTotal > 0 && (j.status === 'running' || j.status === 'done') && (
                        <span>
                          {formatBytes(j.bytesDone, prefs.sizeUnits)} /{' '}
                          {formatBytes(j.bytesTotal, prefs.sizeUnits)}
                        </span>
                      )}
                      <span>{formatDate(j.createdAt, prefs.dateFormat)}</span>
                    </div>
                    {j.status === 'running' && (
                      <div className="mt-2">
                        <Progress value={j.bytesDone} total={j.bytesTotal} indeterminate={!j.bytesTotal} />
                      </div>
                    )}
                    {j.error && (
                      <div className="selectable mt-2 text-xs break-words text-danger">{j.error}</div>
                    )}
                    {j.result && j.status === 'done' && (
                      <div className="selectable mt-1 text-xs break-all text-ok">{j.result}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {j.status === 'done' && j.kind === 'export' && j.result && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => api.app.showItemInFolder(j.result!)}
                        title="Show in folder"
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    )}
                    {(j.status === 'running' || j.status === 'queued') && (
                      <Button size="sm" onClick={() => api.transfers.cancel(j.id)}>
                        <X className="size-3.5" /> Cancel
                      </Button>
                    )}
                    {(j.status === 'failed' || j.status === 'cancelled') && (
                      <Button
                        size="sm"
                        onClick={() => api.transfers.retry(j.id).then(useApp.getState().upsertJob)}
                      >
                        <RotateCcw className="size-3.5" /> Retry
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: Job['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="mt-0.5 size-4 animate-spin text-accent" />
    case 'queued':
      return <Loader2 className="mt-0.5 size-4 text-muted" />
    case 'done':
      return <CheckCircle2 className="mt-0.5 size-4 text-ok" />
    case 'failed':
      return <XCircle className="mt-0.5 size-4 text-danger" />
    case 'cancelled':
      return <CircleSlash className="mt-0.5 size-4 text-muted" />
  }
}
