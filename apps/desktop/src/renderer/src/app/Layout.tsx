import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import {
  ArrowLeftRight,
  Check,
  ChevronsUpDown,
  Compass,
  HardDrive,
  Lock,
  Server,
  Settings,
  SlidersHorizontal,
  CircleHelp
} from 'lucide-react'
import { t } from '../i18n'
import { api, cn } from '../lib/format'
import { useRegistries } from '../lib/queries'
import { rememberedRegistryId, useApp } from '../stores/app'
import { Badge, Input, Modal } from '../components/ui'
import { APP_NAME, AppLogo } from '../components/AppLogo'

const NAV = [
  { to: '/explorer', label: () => t('nav.explorer'), icon: Compass },
  { to: '/registries', label: () => t('nav.registries'), icon: Server },
  { to: '/local', label: () => t('nav.local'), icon: HardDrive },
  { to: '/transfers', label: () => t('nav.transfers'), icon: ArrowLeftRight },
  { to: '/settings', label: () => t('nav.settings'), icon: Settings },
  { to: '/preferences', label: () => t('nav.preferences'), icon: SlidersHorizontal },
  { to: '/help', label: () => t('nav.help'), icon: CircleHelp }
]

export function Layout() {
  const { data: registries = [] } = useRegistries()
  const activeId = useApp((s) => s.activeRegistryId)
  const setActive = useApp((s) => s.setActiveRegistry)
  const docker = useApp((s) => s.docker)
  const jobs = useApp((s) => s.jobs)
  const [switcher, setSwitcher] = useState(false)
  const navigate = useNavigate()
  const isMac = navigator.userAgent.includes('Mac')

  // Pick the remembered or default registry once the list loads.
  useEffect(() => {
    if (!registries.length) return
    if (activeId && registries.some((r) => r.id === activeId)) return
    const remembered = rememberedRegistryId()
    const pick =
      registries.find((r) => r.id === remembered) ?? registries.find((r) => r.isDefault) ?? registries[0]
    setActive(pick.id)
  }, [registries, activeId, setActive])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSwitcher((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const active = registries.find((r) => r.id === activeId)
  const runningJobs = Object.values(jobs).filter(
    (j) => j.status === 'running' || j.status === 'queued'
  ).length

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel">
        {/* macOS: keep the traffic-light buttons on their own strip; name and logo go on the line below. */}
        {isMac && <div className="drag h-9 shrink-0" />}
        <div className={cn('drag flex items-center gap-2.5 px-4', isMac ? 'pb-3' : 'py-3')}>
          <AppLogo className="size-8" />
          <span className="text-sm leading-tight font-semibold">{APP_NAME}</span>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={() => setSwitcher(true)}
            className="flex w-full items-center gap-2 rounded-md border border-border bg-panel-2 px-2.5 py-2 text-left hover:border-accent/50"
            title={`Switch registry (${isMac ? '⌘' : 'Ctrl+'}K)`}
          >
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: active?.color ?? 'var(--muted)' }}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{active?.name ?? 'No registry'}</span>
              <span className="block truncate text-[11px] text-muted">
                {active ? active.url.replace(/^https?:\/\//, '') : 'Add one to get started'}
              </span>
            </span>
            <ChevronsUpDown className="size-4 text-muted" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm',
                  isActive ? 'bg-accent/10 font-medium text-accent' : 'text-fg hover:bg-panel-2'
                )
              }
            >
              <Icon className="size-4" />
              <span className="flex-1">{label()}</span>
              {to === '/transfers' && runningJobs > 0 && <Badge tone="accent">{runningJobs}</Badge>}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-2 border-t border-border px-3 py-3">
          <button
            onClick={() => navigate('/preferences')}
            className="flex w-full items-center gap-2 text-left text-xs text-muted hover:text-fg"
            title={docker?.message ?? docker?.endpoint}
          >
            <span
              className={cn(
                'size-2 rounded-full',
                docker?.state === 'connected'
                  ? 'bg-ok'
                  : docker?.state === 'not-running'
                    ? 'bg-warn'
                    : 'bg-danger'
              )}
            />
            <span className="truncate">
              {docker?.state === 'connected'
                ? `Docker ${docker.version ?? ''}`
                : docker?.state === 'not-running'
                  ? 'Docker not running'
                  : docker
                    ? 'Docker not found'
                    : 'Checking Docker…'}
            </span>
          </button>
          <button
            onClick={() => api.vault.lock().then(useApp.getState().setVault)}
            className="flex w-full items-center gap-2 text-left text-xs text-muted hover:text-fg"
          >
            <Lock className="size-3.5" /> Lock ({isMac ? '⌘' : 'Ctrl+'}L)
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>

      <RegistrySwitcher
        open={switcher}
        onClose={() => setSwitcher(false)}
        onPick={(id) => {
          setActive(id)
          setSwitcher(false)
          navigate('/explorer')
        }}
        onManage={() => {
          setSwitcher(false)
          navigate('/registries')
        }}
      />
    </div>
  )
}

function RegistrySwitcher({
  open,
  onClose,
  onPick,
  onManage
}: {
  open: boolean
  onClose: () => void
  onPick: (id: string) => void
  onManage: () => void
}) {
  const { data: registries = [] } = useRegistries()
  const activeId = useApp((s) => s.activeRegistryId)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const filtered = useMemo(
    () => registries.filter((r) => `${r.name} ${r.url} ${r.type}`.toLowerCase().includes(q.toLowerCase())),
    [registries, q]
  )
  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
    }
  }, [open])

  return (
    <Modal open={open} onClose={onClose} title="Switch registry">
      <Input
        autoFocus
        placeholder="Search registries…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setCursor(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setCursor((c) => Math.min(filtered.length - 1, c + 1))
          if (e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1))
          if (e.key === 'Enter' && filtered[cursor]) onPick(filtered[cursor].id)
        }}
      />
      <ul className="mt-3 space-y-0.5">
        {filtered.map((r, i) => (
          <li key={r.id}>
            <button
              onClick={() => onPick(r.id)}
              onMouseEnter={() => setCursor(i)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left',
                i === cursor ? 'bg-panel-2' : ''
              )}
            >
              <span className="size-2.5 rounded-full" style={{ background: r.color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.name}</span>
                <span className="block truncate text-xs text-muted">{r.url}</span>
              </span>
              {r.id === activeId && <Check className="size-4 text-accent" />}
            </button>
          </li>
        ))}
        {!filtered.length && <li className="px-3 py-4 text-sm text-muted">No registries match.</li>}
      </ul>
      <button onClick={onManage} className="mt-3 text-sm text-accent hover:underline">
        Manage registries…
      </button>
    </Modal>
  )
}
