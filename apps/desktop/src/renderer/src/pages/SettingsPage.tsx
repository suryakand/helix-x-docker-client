import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Settings } from '@helix/shared/types'
import { Button, Card, ErrorBox, Field, Input, Modal, Row, Select, Switch } from '../components/ui'
import { PageHeader } from '../components/PageHeader'
import { api, errorMessage, formatBytes } from '../lib/format'
import { useSettings } from '../lib/queries'
import { useApp } from '../stores/app'
import { passwordStrength } from './LoginPage'

export function SettingsPage() {
  const { data: settings } = useSettings()
  const vault = useApp((s) => s.vault)!
  const setVault = useApp((s) => s.setVault)
  const toast = useApp((s) => s.toast)
  const qc = useQueryClient()
  const [pwOpen, setPwOpen] = useState(false)
  const cache = useQuery({ queryKey: ['cache-stats'], queryFn: () => api.app.cacheStats() })
  const info = useQuery({ queryKey: ['app-info'], queryFn: () => api.app.info(), staleTime: Infinity })

  const update = async (patch: Partial<Settings>) => {
    try {
      const next = await api.settings.update(patch)
      qc.setQueryData(['settings'], next)
      if (patch.dockerHost !== undefined) void qc.invalidateQueries({ queryKey: ['docker-storage'] })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  if (!settings) return null
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" subtitle="Security, network, Docker engine and transfer settings." />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="space-y-5">
          <Card title="Security">
            <div className="divide-y divide-border">
              <Row
                label="Auto-lock after inactivity"
                description="Lock the vault when the computer has been idle. 0 = never."
              >
                <Select
                  className="w-40"
                  value={settings.autoLockMinutes}
                  onChange={(e) => update({ autoLockMinutes: Number(e.target.value) })}
                >
                  {[0, 1, 5, 10, 15, 30, 60, 120, 240].map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? 'Never' : `${m} minutes`}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label="Lock on sleep / screen lock">
                <Switch checked={settings.lockOnSleep} onChange={(v) => update({ lockOnSleep: v })} />
              </Row>
              <Row
                label={
                  vault.biometricAvailable ? 'Unlock with Touch ID / keychain' : 'Unlock with OS keychain'
                }
                description={
                  vault.keychainAvailable
                    ? 'Stores the vault key in the OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service) so you can unlock without typing the master password.'
                    : 'No secure OS keychain is available on this system.'
                }
              >
                <Switch
                  checked={vault.keychainEnabled}
                  disabled={!vault.keychainAvailable}
                  onChange={async (v) => {
                    try {
                      setVault(await api.vault.setKeychainUnlock(v))
                    } catch (err) {
                      toast(errorMessage(err), 'error')
                    }
                  }}
                />
              </Row>
              <Row
                label="Master password"
                description="Re-encrypts the vault key; saved credentials are kept."
              >
                <Button onClick={() => setPwOpen(true)}>Change…</Button>
              </Row>
              <Row
                label="Allow deleting tags in registries"
                description="Hide the risk of accidental deletes by turning this off."
              >
                <Switch checked={settings.allowDeletes} onChange={(v) => update({ allowDeletes: v })} />
              </Row>
              <Row label="Reset vault" description="Deletes every saved credential on this device.">
                <Button variant="danger" onClick={async () => setVault(await api.vault.reset())}>
                  Reset…
                </Button>
              </Row>
            </div>
          </Card>

          <Card title="Docker engine">
            <DockerEndpoint value={settings.dockerHost} onSave={(v) => update({ dockerHost: v })} />
          </Card>

          <Card title="Network">
            <div className="divide-y divide-border">
              <Row
                label="Proxy"
                description="System uses HTTPS_PROXY / HTTP_PROXY / NO_PROXY environment variables."
              >
                <Select
                  className="w-40"
                  value={settings.proxy.mode}
                  onChange={(e) =>
                    update({
                      proxy: { ...settings.proxy, mode: e.target.value as Settings['proxy']['mode'] }
                    })
                  }
                >
                  <option value="system">System</option>
                  <option value="none">No proxy</option>
                  <option value="manual">Manual</option>
                </Select>
              </Row>
              {settings.proxy.mode === 'manual' && (
                <div className="grid grid-cols-2 gap-3 py-3">
                  <Field label="Proxy URL">
                    <DeferredInput
                      value={settings.proxy.url}
                      placeholder="http://proxy.corp:3128"
                      onCommit={(url) => update({ proxy: { ...settings.proxy, url } })}
                    />
                  </Field>
                  <Field label="Bypass for">
                    <DeferredInput
                      value={settings.proxy.noProxy}
                      placeholder="localhost,.corp"
                      onCommit={(noProxy) => update({ proxy: { ...settings.proxy, noProxy } })}
                    />
                  </Field>
                </div>
              )}
              <div className="py-3">
                <div className="text-sm font-medium">Trusted CA certificates</div>
                <div className="mb-2 text-xs text-muted">
                  Added to the system trust store for every registry (corporate TLS inspection, private PKI).
                </div>
                <ul className="mb-2 space-y-1">
                  {settings.caFiles.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs">
                      <code className="selectable min-w-0 flex-1 truncate">{f}</code>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => update({ caFiles: settings.caFiles.filter((x) => x !== f) })}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  onClick={async () => {
                    const f = await api.app.chooseFile('Add CA certificate', ['pem', 'crt', 'cer'])
                    if (f) await update({ caFiles: [...new Set([...settings.caFiles, f])] })
                  }}
                >
                  Add certificate…
                </Button>
              </div>
              <Row label="Request timeout">
                <Select
                  className="w-40"
                  value={settings.requestTimeoutSec}
                  onChange={(e) => update({ requestTimeoutSec: Number(e.target.value) })}
                >
                  {[30, 60, 120, 300, 600].map((s) => (
                    <option key={s} value={s}>
                      {s} seconds
                    </option>
                  ))}
                </Select>
              </Row>
            </div>
          </Card>

          <Card title="Transfers & storage">
            <div className="divide-y divide-border">
              <Row label="Default export folder" description={settings.downloadDir}>
                <Button
                  onClick={async () => {
                    const d = await api.app.chooseDirectory('Default export folder')
                    if (d) await update({ downloadDir: d })
                  }}
                >
                  Change…
                </Button>
              </Row>
              <Row label="Parallel jobs">
                <Select
                  className="w-40"
                  value={settings.jobConcurrency}
                  onChange={(e) => update({ jobConcurrency: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </Row>
              <Row label="Parallel layer downloads / uploads per job">
                <Select
                  className="w-40"
                  value={settings.blobConcurrency}
                  onChange={(e) => update({ blobConcurrency: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 6, 8, 12, 16].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </Row>
              <Row
                label="Layer cache"
                description="Re-use downloaded layers across pulls and exports (verified by digest)."
              >
                <Switch
                  checked={settings.blobCache.enabled}
                  onChange={(v) => update({ blobCache: { ...settings.blobCache, enabled: v } })}
                />
              </Row>
              <Row
                label="Cache size limit"
                description={
                  cache.data
                    ? `${formatBytes(cache.data.sizeBytes)} in ${cache.data.blobs} blobs · ${cache.data.path}`
                    : undefined
                }
              >
                <div className="flex gap-2">
                  <Select
                    className="w-28"
                    value={settings.blobCache.maxSizeGb}
                    onChange={(e) =>
                      update({ blobCache: { ...settings.blobCache, maxSizeGb: Number(e.target.value) } })
                    }
                  >
                    {[1, 2, 5, 10, 20, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        {n} GB
                      </option>
                    ))}
                  </Select>
                  <Button
                    onClick={async () => {
                      await api.app.clearCache()
                      void cache.refetch()
                      toast('Layer cache cleared')
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </Row>
            </div>
          </Card>

          <Card title="Diagnostics">
            <div className="divide-y divide-border">
              <Row label="Log level">
                <Select
                  className="w-40"
                  value={settings.logLevel}
                  onChange={(e) => update({ logLevel: e.target.value as Settings['logLevel'] })}
                >
                  <option value="error">Error</option>
                  <option value="warn">Warning</option>
                  <option value="info">Info</option>
                  <option value="debug">Debug</option>
                </Select>
              </Row>
              <Row label="Log files" description={info.data?.logsPath}>
                <Button onClick={() => api.app.openLogs()}>Open folder</Button>
              </Row>
              {info.data && (
                <Row
                  label="About"
                  description={`Electron ${info.data.electron} · Chrome ${info.data.chrome} · Node ${info.data.node} · ${info.data.platform}/${info.data.arch}`}
                >
                  <span className="text-sm font-medium">v{info.data.version}</span>
                </Row>
              )}
            </div>
          </Card>
        </div>
      </div>
      {pwOpen && <ChangePasswordDialog onClose={() => setPwOpen(false)} />}
    </div>
  )
}

function DeferredInput({
  value,
  onCommit,
  placeholder
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <Input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === 'Enter' && onCommit(v)}
    />
  )
}

function DockerEndpoint({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const docker = useApp((s) => s.docker)
  return (
    <div className="space-y-3 py-3">
      <Field
        label="Engine endpoint"
        help={
          <>
            Leave empty to auto-detect (DOCKER_HOST → current docker context → default socket). Examples:{' '}
            <code>unix:///var/run/docker.sock</code>, <code>npipe:////./pipe/docker_engine</code>,{' '}
            <code>tcp://192.168.1.10:2375</code>.
          </>
        }
      >
        <DeferredInput value={value} onCommit={onSave} placeholder={docker?.endpoint ?? 'auto'} />
      </Field>
      <div className="text-xs text-muted">
        Current: <code className="selectable">{docker?.endpoint ?? '—'}</code> ({docker?.endpointSource}
        {docker?.contextName ? `, context ${docker.contextName}` : ''}) —{' '}
        {docker?.state === 'connected' ? `connected, Docker ${docker.version}` : docker?.message}
      </div>
    </div>
  )
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const toast = useApp((s) => s.toast)
  const strength = passwordStrength(next)
  return (
    <Modal
      open
      onClose={onClose}
      title="Change master password"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (next.length < 8) return setError('Use at least 8 characters')
              if (next !== confirm) return setError('New passwords do not match')
              setBusy(true)
              setError(undefined)
              try {
                await api.vault.changePassword(current, next)
                toast('Master password changed', 'success')
                onClose()
              } catch (err) {
                setError(errorMessage(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            Change password
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
        </Field>
        <Field label="New password" help={next ? strength.label : undefined}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error && <ErrorBox error={error} />}
      </div>
    </Modal>
  )
}
