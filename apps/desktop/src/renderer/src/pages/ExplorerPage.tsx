import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRightLeft,
  Box,
  Download,
  FileDown,
  FolderOpen,
  HardDriveDownload,
  Layers,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Server,
  Tag,
  Trash2,
  Upload
} from 'lucide-react'
import type { ImageDetails, Platform, RegistrySummary } from '@helix/shared/types'
import { Badge, Button, CopyButton, Empty, ErrorBox, Input, Spinner, Tabs } from '../components/ui'
import { PageHeader } from '../components/PageHeader'
import { CopyDialog, ImportDialog, PullDialog, RetagDialog, exportImage } from '../components/ImageActions'
import { api, cn, formatBytes, formatDate, platformLabel, shortDigest } from '../lib/format'
import { useRegistries } from '../lib/queries'
import { useInView } from '../lib/useInView'
import { confirmAction, useApp } from '../stores/app'

export function ExplorerPage() {
  const { data: registries = [], isLoading } = useRegistries()
  const activeId = useApp((s) => s.activeRegistryId)
  const registry = registries.find((r) => r.id === activeId)
  const navigate = useNavigate()

  if (!isLoading && !registries.length) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Explorer" />
        <Empty icon={<Server className="size-10" />} title="Connect a registry to start exploring">
          <Button variant="primary" className="mt-4" onClick={() => navigate('/registries')}>
            Add registry
          </Button>
        </Empty>
      </div>
    )
  }
  if (!registry)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  return <Explorer key={registry.id} registry={registry} />
}

function Explorer({ registry }: { registry: RegistrySummary }) {
  const [params, setParams] = useSearchParams()
  const repo = params.get('repo') ?? undefined
  const tag = params.get('tag') ?? undefined
  const [importOpen, setImportOpen] = useState(false)
  const select = (next: { repo?: string; tag?: string }) => {
    const p = new URLSearchParams()
    if (next.repo) p.set('repo', next.repo)
    if (next.tag) p.set('tag', next.tag)
    setParams(p, { replace: true })
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: registry.color }} />
            {registry.name}
          </span>
        }
        subtitle={registry.url}
        actions={
          <Button onClick={() => setImportOpen(true)}>
            <Upload className="size-4" /> Import .tar
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <RepoList registry={registry} selected={repo} onSelect={(r) => select({ repo: r })} />
        <div className="flex min-w-0 flex-1">
          {repo ? (
            <>
              <TagList
                registry={registry}
                repo={repo}
                selected={tag}
                onSelect={(t) => select({ repo, tag: t })}
              />
              {tag && (
                <ImagePanel registry={registry} repo={repo} tag={tag} onDeleted={() => select({ repo })} />
              )}
            </>
          ) : (
            <Empty icon={<Box className="size-10" />} title="Select a repository">
              Pick a repository on the left, or open one by name.
            </Empty>
          )}
        </div>
      </div>
      {importOpen && (
        <ImportDialog registry={registry} defaultRepo={repo} onClose={() => setImportOpen(false)} />
      )}
    </div>
  )
}

function RepoList({
  registry,
  selected,
  onSelect
}: {
  registry: RegistrySummary
  selected?: string
  onSelect: (r: string) => void
}) {
  const [filter, setFilter] = useState('')
  const qc = useQueryClient()
  const q = useInfiniteQuery({
    queryKey: ['repos', registry.id],
    queryFn: ({ pageParam }) => api.explorer.listRepositories(registry.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next,
    staleTime: 60_000
  })
  const pages = useMemo(() => q.data?.pages ?? [], [q.data])
  const all = useMemo(() => [...new Set(pages.flatMap((p) => p.items))], [pages])
  const unsupported = pages[0]?.listingUnsupported
  const message = pages[0]?.message
  const pinned = registry.pinnedRepos
  const f = filter.trim().toLowerCase()
  const visible = all.filter((r) => r.toLowerCase().includes(f))
  const visiblePinned = pinned.filter((r) => r.toLowerCase().includes(f))

  const togglePin = async (r: string) => {
    await api.registries.setPinned(
      registry.id,
      pinned.includes(r) ? pinned.filter((x) => x !== r) : [r, ...pinned]
    )
    void qc.invalidateQueries({ queryKey: ['registries'] })
  }

  const openByName = () => {
    const name = filter.trim()
    if (name) {
      onSelect(name)
      if (!pinned.includes(name) && !all.includes(name)) void togglePin(name)
    }
  }

  const item = (r: string) => (
    <li key={r} className="group">
      <button
        onClick={() => onSelect(r)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm',
          selected === r ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-panel-2'
        )}
      >
        <Box className="size-3.5 shrink-0 opacity-60" />
        <span className="selectable min-w-0 flex-1 truncate">{r}</span>
        <span
          role="button"
          tabIndex={-1}
          title={pinned.includes(r) ? 'Unpin' : 'Pin'}
          onClick={(e) => {
            e.stopPropagation()
            void togglePin(r)
          }}
          className="hidden text-muted group-hover:inline hover:text-fg"
        >
          {pinned.includes(r) ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </span>
      </button>
    </li>
  )

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-border bg-panel">
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted" />
          <Input
            className="pl-8"
            placeholder={unsupported ? 'Repository name, e.g. team/app' : 'Filter or open repository…'}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && openByName()}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            {q.isLoading
              ? 'Loading…'
              : unsupported
                ? 'Listing unavailable'
                : `${all.length}${q.hasNextPage ? '+' : ''} repositories`}
          </span>
          <div className="flex gap-1">
            {filter.trim() && (
              <Button size="sm" variant="ghost" onClick={openByName} title="Open repository by name">
                <FolderOpen className="size-3.5" /> Open
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => q.refetch()} title="Refresh">
              <RefreshCw className={cn('size-3.5', q.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {q.error && <ErrorBox error={q.error} />}
        {unsupported && message && (
          <div className="mb-2 rounded-md bg-warn/10 px-2.5 py-2 text-xs text-warn">{message}</div>
        )}
        {visiblePinned.length > 0 && (
          <>
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
              Pinned
            </div>
            <ul className="mb-2">{visiblePinned.map(item)}</ul>
            <div className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
              All
            </div>
          </>
        )}
        <ul>{visible.filter((r) => !pinned.includes(r)).map(item)}</ul>
        {q.hasNextPage && (
          <div className="p-2">
            <Button
              size="sm"
              className="w-full"
              onClick={() => q.fetchNextPage()}
              loading={q.isFetchingNextPage}
            >
              Load more
            </Button>
          </div>
        )}
        {!q.isLoading && !unsupported && !visible.length && !visiblePinned.length && (
          <div className="px-3 py-6 text-center text-xs text-muted">
            {f ? 'No matches — press Enter to open by name.' : 'No repositories.'}
          </div>
        )}
      </div>
    </div>
  )
}

function TagRow({
  registry,
  repo,
  tag,
  selected,
  onSelect
}: {
  registry: RegistrySummary
  repo: string
  tag: string
  selected: boolean
  onSelect: () => void
}) {
  const prefs = useApp((s) => s.prefs)!
  // Only rows scrolled into view fetch their summary (each one costs registry requests).
  const [ref, visible] = useInView<HTMLTableRowElement>()
  const s = useQuery({
    queryKey: ['tag-summary', registry.id, repo, tag],
    queryFn: () => api.explorer.tagSummary(registry.id, repo, tag),
    staleTime: 5 * 60_000,
    enabled: visible
  })
  return (
    <tr
      ref={ref}
      onClick={onSelect}
      className={cn(
        'cursor-pointer border-b border-border whitespace-nowrap',
        selected ? 'bg-accent/10' : 'hover:bg-panel-2'
      )}
    >
      <td className="px-4 py-2">
        <span className="flex items-center gap-1.5 font-medium">
          <Tag className="size-3.5 text-muted" />
          <span className="selectable">{tag}</span>
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-muted">
        {s.data ? shortDigest(s.data.digest) : s.error || !visible ? '—' : <Spinner className="size-3" />}
      </td>
      <td className="px-3 py-2 text-xs">{s.data ? formatBytes(s.data.size, prefs.sizeUnits) : ''}</td>
      <td className="px-3 py-2 text-xs text-muted">
        {s.data ? formatDate(s.data.created, prefs.dateFormat) : ''}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {s.data?.platforms.slice(0, 3).map((p) => (
            <Badge key={platformLabel(p)}>{platformLabel(p)}</Badge>
          ))}
          {(s.data?.platforms.length ?? 0) > 3 && <Badge>+{s.data!.platforms.length - 3}</Badge>}
        </div>
      </td>
    </tr>
  )
}

function TagList({
  registry,
  repo,
  selected,
  onSelect
}: {
  registry: RegistrySummary
  repo: string
  selected?: string
  onSelect: (t: string) => void
}) {
  const [filter, setFilter] = useState('')
  const q = useInfiniteQuery({
    queryKey: ['tags', registry.id, repo],
    queryFn: ({ pageParam }) => api.explorer.listTags(registry.id, repo, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next
  })
  const tags = useMemo(() => {
    const all = [...new Set((q.data?.pages ?? []).flatMap((p) => p.items))]
    // Newest-looking first: "latest" on top, then reverse natural order (1.10 > 1.9).
    return all
      .filter((t) => t.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) =>
        a === 'latest' ? -1 : b === 'latest' ? 1 : b.localeCompare(a, undefined, { numeric: true })
      )
  }, [q.data, filter])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="selectable truncate text-sm font-semibold">{repo}</div>
          <div className="text-xs whitespace-nowrap text-muted">
            {q.isLoading ? 'Loading tags…' : `${tags.length}${q.hasNextPage ? '+' : ''} tags`}
          </div>
        </div>
        <div className="w-40 shrink-0">
          <Input
            className="h-8"
            placeholder="Filter tags"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} title="Refresh">
          <RefreshCw className={cn('size-3.5', q.isFetching && 'animate-spin')} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {q.error && (
          <div className="p-4">
            <ErrorBox error={q.error} />
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-medium">Tag</th>
              <th className="px-3 py-2 font-medium">Digest</th>
              <th className="px-3 py-2 font-medium">Size</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Platforms</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <TagRow
                key={t}
                registry={registry}
                repo={repo}
                tag={t}
                selected={selected === t}
                onSelect={() => onSelect(t)}
              />
            ))}
          </tbody>
        </table>
        {q.hasNextPage && (
          <div className="p-3">
            <Button
              size="sm"
              className="w-full"
              onClick={() => q.fetchNextPage()}
              loading={q.isFetchingNextPage}
            >
              Load more tags
            </Button>
          </div>
        )}
        {!q.isLoading && !q.error && !tags.length && (
          <div className="p-6 text-center text-sm text-muted">No tags.</div>
        )}
      </div>
    </div>
  )
}

function ImagePanel({
  registry,
  repo,
  tag,
  onDeleted
}: {
  registry: RegistrySummary
  repo: string
  tag: string
  onDeleted: () => void
}) {
  const prefs = useApp((s) => s.prefs)!
  const toast = useApp((s) => s.toast)
  const qc = useQueryClient()
  const [platform, setPlatform] = useState<Platform>()
  const [tab, setTab] = useState<'overview' | 'layers' | 'history' | 'raw'>('overview')
  const [dialog, setDialog] = useState<'pull' | 'copy' | 'retag'>()
  const q = useQuery({
    queryKey: ['image', registry.id, repo, tag, platform ? platformLabel(platform) : 'default'],
    queryFn: () => api.explorer.imageDetails(registry.id, repo, tag, platform)
  })
  const d = q.data

  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete ${repo}:${tag}?`,
      message:
        'This deletes the manifest from the registry. Every tag that points to the same digest is removed too. This cannot be undone.',
      confirmLabel: 'Delete from registry',
      danger: true
    })
    if (!ok) return
    try {
      await api.explorer.deleteTag(registry.id, repo, tag)
      toast(`Deleted ${repo}:${tag}`, 'success')
      await qc.invalidateQueries({ queryKey: ['tags', registry.id, repo] })
      onDeleted()
    } catch (err) {
      toast(`Delete failed: ${(err as Error).message}`, 'error')
    }
  }

  return (
    <div className="flex w-[clamp(380px,40%,560px)] shrink-0 flex-col border-l border-border bg-panel">
      <div className="space-y-3 border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="selectable truncate text-base font-semibold">
              {repo}:{tag}
            </div>
            {d && <div className="selectable mt-0.5 truncate font-mono text-xs text-muted">{d.digest}</div>}
          </div>
          {d && d.platforms.length > 1 && (
            <select
              className="select select-sm h-8 rounded-md border border-border bg-panel pl-2.5 text-xs"
              value={platformLabel(d.selectedPlatform)}
              onChange={(e) => setPlatform(d.platforms.find((p) => platformLabel(p) === e.target.value))}
            >
              {d.platforms.map((p) => (
                <option key={platformLabel(p)}>{platformLabel(p)}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" onClick={() => setDialog('pull')} disabled={!d}>
            <HardDriveDownload className="size-3.5" /> Pull to Docker
          </Button>
          <Button
            size="sm"
            onClick={() => d && exportImage(registry, repo, tag, d.selectedPlatform)}
            disabled={!d}
          >
            <FileDown className="size-3.5" /> Export .tar
          </Button>
          <Button size="sm" onClick={() => setDialog('copy')} disabled={!d}>
            <ArrowRightLeft className="size-3.5" /> Copy to…
          </Button>
          <Button size="sm" onClick={() => setDialog('retag')} disabled={!d}>
            <Tag className="size-3.5" /> Retag
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={!d} title="Delete from registry">
            <Trash2 className="size-3.5 text-danger" />
          </Button>
        </div>
        {d && (
          <div className="flex items-center gap-2 rounded-md bg-panel-2 px-3 py-1.5">
            <code className="selectable min-w-0 flex-1 truncate text-xs">{d.pullCommand}</code>
            <CopyButton text={d.pullCommand} />
          </div>
        )}
      </div>
      <div className="px-5 pt-2">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'layers', label: `Layers${d ? ` (${d.layers.length})` : ''}` },
            { value: 'history', label: 'History' },
            { value: 'raw', label: 'Raw' }
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {q.isLoading && <Spinner />}
        {q.error && <ErrorBox error={q.error} />}
        {d && tab === 'overview' && <Overview d={d} units={prefs.sizeUnits} dateStyle={prefs.dateFormat} />}
        {d && tab === 'layers' && (
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1.5 font-medium">#</th>
                <th className="py-1.5 font-medium">Digest</th>
                <th className="py-1.5 font-medium">Type</th>
                <th className="py-1.5 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {d.layers.map((l, i) => (
                <tr key={`${l.digest}-${i}`} className="border-t border-border">
                  <td className="py-1.5 pr-2 text-muted">{i + 1}</td>
                  <td className="selectable py-1.5 font-mono">{shortDigest(l.digest)}</td>
                  <td className="py-1.5 text-muted">
                    {l.mediaType.replace(/^application\/vnd\.(oci\.image|docker\.image\.rootfs)\./, '')}
                  </td>
                  <td className="py-1.5 text-right">{formatBytes(l.size, prefs.sizeUnits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d && tab === 'history' && (
          <ol className="space-y-2">
            {d.config.history.map((h, i) => (
              <li key={i} className="rounded-md border border-border p-2.5">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Layers className="size-3.5" /> {formatDate(h.created, prefs.dateFormat)}{' '}
                  {h.emptyLayer && <Badge>metadata only</Badge>}
                </div>
                <code className="selectable mt-1 block text-xs break-all whitespace-pre-wrap">
                  {h.createdBy?.replace(/^\/bin\/sh -c #\(nop\)\s*/, '') ?? h.comment ?? ''}
                </code>
              </li>
            ))}
            {!d.config.history.length && <div className="text-sm text-muted">No history recorded.</div>}
          </ol>
        )}
        {d && tab === 'raw' && (
          <div className="space-y-4">
            {[
              ['Index', d.rawIndex],
              ['Manifest', d.rawManifest],
              ['Config', d.rawConfig]
            ]
              .filter(([, v]) => v)
              .map(([label, v]) => (
                <div key={label}>
                  <div className="mb-1 flex items-center justify-between text-xs font-semibold">
                    {label} <CopyButton text={v!} />
                  </div>
                  <pre className="max-h-96 overflow-auto rounded-md bg-panel-2 p-3 text-xs">{v}</pre>
                </div>
              ))}
          </div>
        )}
      </div>
      {dialog === 'pull' && d && (
        <PullDialog
          registry={registry}
          repo={repo}
          tag={tag}
          details={d}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog === 'copy' && d && (
        <CopyDialog
          registry={registry}
          repo={repo}
          tag={tag}
          details={d}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog === 'retag' && (
        <RetagDialog registry={registry} repo={repo} tag={tag} onClose={() => setDialog(undefined)} />
      )}
    </div>
  )
}

function Overview({
  d,
  units,
  dateStyle
}: {
  d: ImageDetails
  units: 'si' | 'iec'
  dateStyle: 'relative' | 'absolute'
}) {
  const c = d.config
  const rows: [string, React.ReactNode][] = [
    ['Size', formatBytes(d.totalSize, units)],
    [
      'Created',
      c.created ? `${formatDate(c.created, dateStyle)} (${new Date(c.created).toLocaleString()})` : '—'
    ],
    ['Platform', [c.os, c.architecture, c.variant].filter(Boolean).join('/') || '—'],
    ['Media type', d.mediaType],
    ['Manifest', <span className="font-mono">{shortDigest(d.manifestDigest)}</span>],
    ['Entrypoint', c.entrypoint.join(' ') || '—'],
    ['Cmd', c.cmd.join(' ') || '—'],
    ['Working dir', c.workingDir ?? '—'],
    ['User', c.user ?? '—'],
    ['Exposed ports', c.exposedPorts.join(', ') || '—'],
    ['Volumes', c.volumes.join(', ') || '—']
  ]
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="selectable min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {c.env.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-muted uppercase">Environment</h3>
          <pre className="max-h-48 overflow-auto rounded-md bg-panel-2 p-3 text-xs">{c.env.join('\n')}</pre>
        </div>
      )}
      {Object.keys(c.labels).length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-muted uppercase">Labels</h3>
          <dl className="grid grid-cols-[minmax(0,40%)_1fr] gap-x-4 gap-y-1 text-xs">
            {Object.entries(c.labels).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="selectable truncate font-mono text-muted" title={k}>
                  {k}
                </dt>
                <dd className="selectable break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="text-xs text-muted">
        <Download className="mr-1 inline size-3.5" /> Use <b>Pull to Docker</b> to load this image into your
        local Docker engine without running <code>docker login</code>.
      </div>
    </div>
  )
}
