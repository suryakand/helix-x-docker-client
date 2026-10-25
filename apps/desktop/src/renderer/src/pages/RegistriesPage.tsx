import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  Copy,
  Download,
  LogIn,
  Pencil,
  Plus,
  Server,
  Star,
  Trash2,
  Upload,
  XCircle,
  Zap
} from 'lucide-react'
import { getProvider, PROVIDERS, REGISTRY_COLORS } from '@helix/shared/providers'
import type { RegistryInput, RegistrySummary, RegistryType, TestConnectionResult } from '@helix/shared/types'
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  Spinner,
  Switch,
  Textarea
} from '../components/ui'
import { api, cn, errorMessage } from '../lib/format'
import { useRegistries } from '../lib/queries'
import { confirmAction, useApp } from '../stores/app'
import { PageHeader } from '../components/PageHeader'
import { DocView } from '../components/DocView'
import { docSection, getDoc } from '../lib/docs'

export function RegistriesPage() {
  const { data: registries = [], isLoading } = useRegistries()
  const [editing, setEditing] = useState<RegistrySummary | 'new' | undefined>()
  const [backup, setBackup] = useState<'export' | 'import' | undefined>()
  const [dockerImport, setDockerImport] = useState(false)
  const qc = useQueryClient()
  const toast = useApp((s) => s.toast)
  const setActive = useApp((s) => s.setActiveRegistry)
  const activeId = useApp((s) => s.activeRegistryId)
  const navigate = useNavigate()
  const refresh = () => qc.invalidateQueries({ queryKey: ['registries'] })

  const remove = async (r: RegistrySummary) => {
    const ok = await confirmAction({
      title: `Delete “${r.name}”?`,
      message:
        'The connection and its saved credentials are removed from this device. Nothing is deleted in the registry itself.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await api.registries.remove(r.id)
    if (activeId === r.id) setActive(undefined)
    toast(`Deleted ${r.name}`)
    refresh()
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Registries"
        subtitle="Connections to container registries. Credentials are stored encrypted in your local vault."
        actions={
          <>
            <Button
              onClick={() => setDockerImport(true)}
              title="Import registries you logged in to with `docker login`"
            >
              <LogIn className="size-4" /> Import docker logins
            </Button>
            <Button onClick={() => setBackup('import')}>
              <Upload className="size-4" /> Import
            </Button>
            <Button onClick={() => setBackup('export')} disabled={!registries.length}>
              <Download className="size-4" /> Export
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> Add registry
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {!isLoading && !registries.length ? (
          <Empty icon={<Server className="size-10" />} title="No registries yet">
            Add Docker Hub, GHCR, ECR, GCR/Artifact Registry, ACR, GitLab, Harbor, Nexus, Artifactory or any
            custom registry URL.
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" /> Add registry
              </Button>
              <Button onClick={() => setDockerImport(true)}>
                <LogIn className="size-4" /> Import docker logins
              </Button>
            </div>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {registries.map((r) => (
              <div
                key={r.id}
                className={cn(
                  'group rounded-lg border bg-panel p-4',
                  r.id === activeId ? 'border-accent/60' : 'border-border'
                )}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-1 size-3 shrink-0 rounded-full" style={{ background: r.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-semibold">{r.name}</h3>
                      {r.isDefault && <Badge tone="accent">default</Badge>}
                    </div>
                    <div className="selectable truncate text-xs text-muted">{r.url}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge>{getProvider(r.type).label}</Badge>
                      {r.namespace && <Badge>{r.namespace}</Badge>}
                      {r.hasCredentials ? (
                        <Badge tone="ok">
                          {r.credentialHints.username ?? r.credentialHints.accessKeyId ?? 'credentials saved'}
                        </Badge>
                      ) : (
                        <Badge tone="warn">anonymous</Badge>
                      )}
                      {r.tls.insecureSkipVerify && <Badge tone="danger">TLS verify off</Badge>}
                      {r.tls.plainHttp && <Badge tone="danger">HTTP</Badge>}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setActive(r.id)
                      navigate('/explorer')
                    }}
                  >
                    Explore
                  </Button>
                  <Button size="sm" onClick={() => setEditing(r)}>
                    <Pencil className="size-3.5" /> Edit
                  </Button>
                  <TestButton id={r.id} registry={r} />
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Duplicate"
                    onClick={() => api.registries.duplicate(r.id).then(refresh)}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                  {!r.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Make default"
                      onClick={() => api.registries.setDefault(r.id).then(refresh)}
                    >
                      <Star className="size-3.5" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" title="Delete" onClick={() => remove(r)}>
                    <Trash2 className="size-3.5 text-danger" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <RegistryDialog
          registry={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      {backup && <BackupDialog mode={backup} onClose={() => setBackup(undefined)} />}
      {dockerImport && <DockerLoginsDialog onClose={() => setDockerImport(false)} />}
    </div>
  )
}

function TestButton({ id, registry }: { id: string; registry: RegistrySummary }) {
  const [result, setResult] = useState<TestConnectionResult>()
  const m = useMutation({
    mutationFn: () => api.registries.test({ id, config: registry }),
    onSuccess: setResult
  })
  return (
    <Button size="sm" onClick={() => m.mutate()} loading={m.isPending} title={result?.message}>
      {result ? (
        result.ok ? (
          <CheckCircle2 className="size-3.5 text-ok" />
        ) : (
          <XCircle className="size-3.5 text-danger" />
        )
      ) : (
        <Zap className="size-3.5" />
      )}
      Test
    </Button>
  )
}

type Draft = RegistryInput['config']

function emptyDraft(type: RegistryType = 'generic'): Draft {
  const p = getProvider(type)
  return {
    name: type === 'generic' ? '' : p.label,
    type,
    url: p.defaultUrl ?? '',
    color: REGISTRY_COLORS[Math.floor(Math.random() * REGISTRY_COLORS.length)],
    tls: { insecureSkipVerify: false, plainHttp: false }
  }
}

function RegistryDialog({ registry, onClose }: { registry?: RegistrySummary; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() =>
    registry ? { ...registry, tls: { ...registry.tls } } : emptyDraft()
  )
  const [creds, setCreds] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [test, setTest] = useState<TestConnectionResult>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const qc = useQueryClient()
  const toast = useApp((s) => s.toast)
  const setActive = useApp((s) => s.setActiveRegistry)
  const provider = getProvider(draft.type)

  useEffect(() => setTest(undefined), [draft, creds])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const credentialsPatch = useMemo(() => {
    // Only send fields the user touched; untouched fields keep their stored values on update.
    const out: Record<string, string> = {}
    for (const f of provider.credentials) if (touched[f.key] || !registry) out[f.key] = creds[f.key] ?? ''
    return out
  }, [creds, touched, provider, registry])

  const validate = (): string | undefined => {
    if (!draft.name.trim()) return 'Name is required'
    if (!draft.url.trim()) return 'Registry URL is required'
    if (provider.namespace?.required && !draft.namespace?.trim())
      return `${provider.namespace.label} is required`
    for (const f of provider.credentials) {
      if (f.required && !creds[f.key] && !registry?.credentialHints[f.key]) return `${f.label} is required`
    }
    return undefined
  }

  const runTest = async () => {
    const v = validate()
    if (v) return setError(v)
    setError(undefined)
    setTesting(true)
    try {
      setTest(await api.registries.test({ id: registry?.id, config: draft, credentials: credentialsPatch }))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    const v = validate()
    if (v) return setError(v)
    setBusy(true)
    setError(undefined)
    try {
      const input = { config: draft, credentials: credentialsPatch }
      const saved = registry
        ? await api.registries.update(registry.id, input)
        : await api.registries.create(input)
      await qc.invalidateQueries({ queryKey: ['registries'] })
      if (!registry) setActive(saved.id)
      toast(registry ? `Updated ${saved.name}` : `Added ${saved.name}`, 'success')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={registry ? `Edit ${registry.name}` : 'Add registry'}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-sm">
            {test && (
              <span className={cn('flex items-center gap-1.5', test.ok ? 'text-ok' : 'text-danger')}>
                {test.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                <span className="selectable max-w-md truncate" title={test.message}>
                  {test.ok ? `Connected (${test.auth}, ${test.latencyMs} ms)` : test.message}
                </span>
              </span>
            )}
          </div>
          <Button onClick={runTest} loading={testing}>
            <Zap className="size-4" /> Test connection
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            {registry ? 'Save changes' : 'Add registry'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!registry && (
          <Field label="Registry type">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {PROVIDERS.map((p) => (
                <button
                  key={p.type}
                  type="button"
                  onClick={() => {
                    setDraft((d) => ({
                      ...emptyDraft(p.type),
                      color: d.color,
                      name: d.name && d.type === 'generic' ? d.name : emptyDraft(p.type).name
                    }))
                    setCreds({})
                  }}
                  className={cn(
                    'rounded-md border px-3 py-2 text-left text-sm',
                    draft.type === p.type
                      ? 'border-accent bg-accent/10 font-medium'
                      : 'border-border hover:bg-panel-2'
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Field>
        )}
        <p className="text-xs text-muted">
          {provider.description}{' '}
          <button type="button" className="text-accent hover:underline" onClick={() => setGuideOpen(true)}>
            Setup guide
          </button>
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Display name" required>
            <Input
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Production registry"
            />
          </Field>
          <Field label="Color">
            <div className="flex h-9 items-center gap-1.5">
              {REGISTRY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => set('color', c)}
                  className={cn(
                    'size-6 rounded-full border-2',
                    draft.color === c ? 'border-fg' : 'border-transparent'
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </Field>
          <div className="md:col-span-2">
            <Field
              label="Registry URL"
              required
              help={
                provider.urlLocked
                  ? 'Fixed for this provider.'
                  : 'Host (and optional port). The /v2/ API path is added automatically.'
              }
            >
              <Input
                value={draft.url}
                onChange={(e) => set('url', e.target.value)}
                placeholder={provider.urlPlaceholder}
                disabled={provider.urlLocked}
              />
            </Field>
          </div>
          {provider.namespace && (
            <Field
              label={provider.namespace.label}
              help={provider.namespace.help}
              required={provider.namespace.required}
            >
              <Input
                value={draft.namespace ?? ''}
                onChange={(e) => set('namespace', e.target.value)}
                placeholder={provider.namespace.placeholder}
              />
            </Field>
          )}
          {provider.region && (
            <Field label="AWS region" help="Detected from the URL when left empty.">
              <Input
                value={draft.region ?? ''}
                onChange={(e) => set('region', e.target.value)}
                placeholder="us-east-1"
              />
            </Field>
          )}
          {provider.apiUrl && (
            <Field label={provider.apiUrl.label} help={provider.apiUrl.help}>
              <Input
                value={draft.apiUrl ?? ''}
                onChange={(e) => set('apiUrl', e.target.value)}
                placeholder={provider.apiUrl.placeholder}
              />
            </Field>
          )}
        </div>

        <div className="space-y-4 rounded-lg border border-border p-4">
          <div className="text-sm font-semibold">
            Credentials{' '}
            {provider.credentialsOptional && (
              <span className="font-normal text-muted">(optional — leave empty for anonymous access)</span>
            )}
          </div>
          {provider.credentials.map((f) => {
            const saved = registry?.credentialHints[f.key]
            const placeholder = saved
              ? f.kind === 'text'
                ? saved
                : '•••••••• (saved — type to replace)'
              : f.placeholder
            const props = {
              value: creds[f.key] ?? (f.kind === 'text' && saved && !touched[f.key] ? saved : ''),
              placeholder,
              onChange: (e: { target: { value: string } }) => {
                setCreds((c) => ({ ...c, [f.key]: e.target.value }))
                setTouched((t) => ({ ...t, [f.key]: true }))
              }
            }
            return (
              <Field key={f.key} label={f.label} help={f.help} required={f.required}>
                {f.kind === 'textarea' ? (
                  <Textarea rows={5} {...props} spellCheck={false} />
                ) : (
                  <Input
                    type={f.kind === 'password' ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    {...props}
                  />
                )}
              </Field>
            )
          })}
          {registry?.hasCredentials && (
            <button
              type="button"
              className="text-xs text-danger hover:underline"
              onClick={() => {
                setCreds(Object.fromEntries(provider.credentials.map((f) => [f.key, ''])))
                setTouched(Object.fromEntries(provider.credentials.map((f) => [f.key, true])))
              }}
            >
              Clear saved credentials
            </button>
          )}
        </div>

        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-semibold">Connection security</summary>
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm">Skip TLS certificate verification</div>
                <div className="text-xs text-muted">
                  Only for self-signed lab registries. Prefer adding the CA certificate below.
                </div>
              </div>
              <Switch
                checked={draft.tls.insecureSkipVerify}
                onChange={(v) => set('tls', { ...draft.tls, insecureSkipVerify: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm">Use plain HTTP</div>
                <div className="text-xs text-muted">Unencrypted. Credentials are sent in clear text.</div>
              </div>
              <Switch
                checked={draft.tls.plainHttp}
                onChange={(v) => set('tls', { ...draft.tls, plainHttp: v })}
              />
            </div>
            <Field label="Custom CA certificate (PEM)">
              <div className="flex gap-2">
                <Input value={draft.tls.caFile ?? ''} readOnly placeholder="None" />
                <Button
                  type="button"
                  onClick={async () => {
                    const f = await api.app.chooseFile('Select CA certificate', ['pem', 'crt', 'cer'])
                    if (f) set('tls', { ...draft.tls, caFile: f })
                  }}
                >
                  Browse…
                </Button>
                {draft.tls.caFile && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => set('tls', { ...draft.tls, caFile: undefined })}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </Field>
          </div>
        </details>
        {error && <ErrorBox error={error} />}
      </div>
      {guideOpen && (
        <ProviderGuide
          anchor={provider.docsAnchor}
          title={provider.label}
          onClose={() => setGuideOpen(false)}
        />
      )}
    </Modal>
  )
}

function BackupDialog({ mode, onClose }: { mode: 'export' | 'import'; onClose: () => void }) {
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const toast = useApp((s) => s.toast)
  const qc = useQueryClient()
  const run = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (mode === 'export') {
        const r = await api.registries.exportConfigs(includeSecrets, includeSecrets ? pass : undefined)
        if (r.path) toast(`Exported ${r.count} registries to ${r.path}`, 'success')
      } else {
        const r = await api.registries.importConfigs(pass || undefined)
        if (r.path) toast(`Imported ${r.count} registries`, 'success')
        await qc.invalidateQueries({ queryKey: ['registries'] })
      }
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'export' ? 'Export registry connections' : 'Import registry connections'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={run} loading={busy}>
            {mode === 'export' ? 'Choose file & export' : 'Choose file & import'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {mode === 'export' ? (
          <>
            <p className="text-muted">
              Saves registry connections to a JSON file you can import on another machine.
            </p>
            <div className="flex items-center justify-between">
              <span>Include credentials (encrypted with a passphrase)</span>
              <Switch checked={includeSecrets} onChange={setIncludeSecrets} />
            </div>
            {includeSecrets && (
              <Field
                label="Export passphrase"
                help="At least 8 characters. Needed to import the credentials."
              >
                <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
              </Field>
            )}
          </>
        ) : (
          <>
            <p className="text-muted">
              Imports connections from a Helix-X Docker Client export. Existing connections with the same id
              are updated.
            </p>
            <Field label="Passphrase (only if the export contains credentials)">
              <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </Field>
          </>
        )}
        {error && <ErrorBox error={error} />}
      </div>
    </Modal>
  )
}

/** Setup instructions for one provider, shown over the registry form so the draft is kept. */
function ProviderGuide({ anchor, title, onClose }: { anchor: string; title: string; onClose: () => void }) {
  const navigate = useNavigate()
  const markdown =
    docSection(getDoc('registries').markdown, anchor) ?? 'No guide available for this registry type.'
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Setup guide — ${title}`}
      footer={
        <>
          <Button onClick={() => navigate(`/help?doc=registries&section=${encodeURIComponent(anchor)}`)}>
            Open in Help
          </Button>
          <Button variant="primary" onClick={onClose}>
            Back to form
          </Button>
        </>
      }
    >
      <DocView markdown={markdown} />
    </Modal>
  )
}

/** Import registries the docker CLI is already logged in to (config.json + credential helpers). */
function DockerLoginsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useApp((s) => s.toast)
  const scan = useQuery({
    queryKey: ['docker-logins'],
    queryFn: () => api.registries.scanDockerLogins(),
    gcTime: 0
  })
  const importable = (scan.data?.candidates ?? []).filter((c) => c.supported && !c.alreadyAdded)
  const [selected, setSelected] = useState<Set<string> | undefined>()
  const chosen = selected ?? new Set(importable.map((c) => c.server))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const run = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const r = await api.registries.importDockerLogins([...chosen])
      await qc.invalidateQueries({ queryKey: ['registries'] })
      toast(
        r.count ? `Imported ${r.count} ${r.count === 1 ? 'registry' : 'registries'}` : 'Nothing to import',
        'success'
      )
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Import docker logins"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={run} loading={busy} disabled={!chosen.size}>
            Import {chosen.size || ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Registries you signed in to with <code>docker login</code>
          {scan.data ? (
            <>
              {' '}
              (from <code className="selectable">{scan.data.configPath}</code> and its credential helpers)
            </>
          ) : null}
          . Credentials are copied into your encrypted vault; your Docker configuration is not changed.
        </p>
        {scan.isLoading && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Reading Docker credentials… your OS may ask for permission to access the keychain.
          </div>
        )}
        {scan.error && <ErrorBox error={scan.error} />}
        {scan.data && !scan.data.candidates.length && (
          <div className="text-muted">No docker logins found.</div>
        )}
        {scan.data && scan.data.candidates.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {scan.data.candidates.map((c) => {
              const disabled = !c.supported || c.alreadyAdded
              return (
                <li
                  key={c.server}
                  className={cn('flex items-start gap-3 px-3 py-2.5', disabled && 'opacity-60')}
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Import ${c.server}`}
                    disabled={disabled}
                    checked={!disabled && chosen.has(c.server)}
                    onChange={(e) => {
                      const next = new Set(chosen)
                      if (e.target.checked) next.add(c.server)
                      else next.delete(c.server)
                      setSelected(next)
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="selectable font-medium break-all">
                        {c.url.replace(/^https?:\/\//, '')}
                      </span>
                      <Badge>{getProvider(c.type).label}</Badge>
                      {c.alreadyAdded && <Badge tone="ok">already added</Badge>}
                      {!c.supported && <Badge tone="warn">not importable</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {c.username || 'no username'} · {c.source}
                    </div>
                    {c.note && <div className="mt-0.5 text-xs text-warn">{c.note}</div>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {scan.data && scan.data.warnings.length > 0 && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">{scan.data.warnings.length} warning(s)</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {scan.data.warnings.map((w) => (
                <li key={w} className="selectable break-all">
                  {w}
                </li>
              ))}
            </ul>
          </details>
        )}
        {error && <ErrorBox error={error} />}
      </div>
    </Modal>
  )
}
