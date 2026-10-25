import { useEffect, useState, type FormEvent } from 'react'
import { Fingerprint, KeyRound } from 'lucide-react'
import { AppLogo } from '../components/AppLogo'
import { Button, ErrorBox, Field, Input } from '../components/ui'
import { t } from '../i18n'
import { api, cn, errorMessage } from '../lib/format'
import { useApp } from '../stores/app'

export function passwordStrength(pw: string): { score: number; label: string } {
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (pw.length >= 16) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  const s = Math.min(4, Math.floor(score * 0.7))
  return { score: s, label: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][s] }
}

export function LoginPage() {
  const vault = useApp((s) => s.vault)!
  const setVault = useApp((s) => s.setVault)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const setup = !vault.initialized
  const strength = passwordStrength(password)

  const tryKeychain = async () => {
    setError(undefined)
    setBusy(true)
    try {
      setVault(await api.vault.unlockWithKeychain())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // Offer keychain / Touch ID unlock straight away when it is enabled.
    if (vault.initialized && vault.keychainEnabled) void tryKeychain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(undefined)
    if (setup) {
      if (password.length < 8) return setError('Use at least 8 characters')
      if (password !== confirm) return setError('Passwords do not match')
    }
    setBusy(true)
    try {
      setVault(setup ? await api.vault.setup(password) : await api.vault.unlock(password))
    } catch (err) {
      setError(errorMessage(err))
      setVault(await api.vault.status())
    } finally {
      setBusy(false)
      setPassword('')
      setConfirm('')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-10 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-6">
        <form
          onSubmit={submit}
          className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-panel p-7 shadow-sm"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <AppLogo className="size-16" />
            <div>
              <h1 className="text-lg font-semibold">{setup ? t('setup.title') : t('login.title')}</h1>
              <p className="mt-1 text-sm text-muted">{setup ? t('setup.subtitle') : t('login.subtitle')}</p>
            </div>
          </div>

          <Field label="Master password">
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={setup ? 'new-password' : 'current-password'}
            />
          </Field>
          {setup && (
            <>
              <div className="space-y-1">
                <div className="flex gap-1">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className={cn(
                        'h-1 flex-1 rounded-full',
                        i < strength.score
                          ? strength.score >= 3
                            ? 'bg-ok'
                            : strength.score === 2
                              ? 'bg-warn'
                              : 'bg-danger'
                          : 'bg-panel-2'
                      )}
                    />
                  ))}
                </div>
                {password && <div className="text-xs text-muted">{strength.label}</div>}
              </div>
              <Field label="Confirm password">
                <Input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}

          {error && <ErrorBox error={error} />}
          {vault.retryAfterSec > 0 && (
            <div className="text-xs text-warn">Too many attempts — wait {vault.retryAfterSec}s.</div>
          )}

          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!password}>
            <KeyRound className="size-4" /> {setup ? 'Create vault' : 'Unlock'}
          </Button>

          {!setup && vault.keychainEnabled && (
            <Button type="button" className="w-full" onClick={tryKeychain} disabled={busy}>
              <Fingerprint className="size-4" />{' '}
              {vault.biometricAvailable ? 'Unlock with Touch ID' : 'Unlock with OS keychain'}
            </Button>
          )}

          {!setup && (
            <button
              type="button"
              className="block w-full text-center text-xs text-muted hover:text-danger"
              onClick={async () => setVault(await api.vault.reset())}
            >
              Forgot password? Reset vault (deletes saved credentials)
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
