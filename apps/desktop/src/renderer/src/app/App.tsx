import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { ConfirmHost, Spinner, Toasts } from '../components/ui'
import { setLanguage } from '../i18n'
import { api } from '../lib/format'
import { useApp } from '../stores/app'
import { Layout } from './Layout'
import { LoginPage } from '../pages/LoginPage'
import { RegistriesPage } from '../pages/RegistriesPage'
import { ExplorerPage } from '../pages/ExplorerPage'
import { LocalImagesPage } from '../pages/LocalImagesPage'
import { TransfersPage } from '../pages/TransfersPage'
import { SettingsPage } from '../pages/SettingsPage'
import { PreferencesPage } from '../pages/PreferencesPage'
import { HelpPage } from '../pages/HelpPage'

function useTheme() {
  const prefs = useApp((s) => s.prefs)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = prefs?.theme === 'dark' || ((prefs?.theme ?? 'system') === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.classList.toggle('compact', prefs?.density === 'compact')
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [prefs?.theme, prefs?.density])
  useEffect(() => setLanguage(prefs?.language ?? 'en'), [prefs?.language])
}

export function App() {
  const vault = useApp((s) => s.vault)
  const prefs = useApp((s) => s.prefs)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])
  useTheme()

  useEffect(() => {
    const s = useApp.getState()
    api.vault.status().then(s.setVault)
    api.settings.getPreferences().then(s.setPrefs)
    return api.onEvent((e) => {
      const st = useApp.getState()
      switch (e.type) {
        case 'vault':
          st.setVault(e.status)
          if (!e.status.unlocked) qc.clear()
          break
        case 'docker':
          st.setDocker(e.status)
          break
        case 'job':
          st.upsertJob(e.job)
          if (e.job.status === 'done') {
            st.toast(`${e.job.title} — done`, 'success')
            if (e.job.kind === 'pull' || e.job.kind === 'load')
              void qc.invalidateQueries({ queryKey: ['local-images'] })
            if (['import', 'push', 'copy'].includes(e.job.kind))
              void qc.invalidateQueries({ queryKey: ['tags'] })
          } else if (e.job.status === 'failed') {
            st.toast(`${e.job.title} failed: ${e.job.error}`, 'error')
          }
          break
        case 'job-removed':
          st.removeJob(e.id)
          break
        case 'registries-changed':
          void qc.invalidateQueries({ queryKey: ['registries'] })
          break
        case 'navigate':
          navigateRef.current(e.path)
          break
      }
    })
  }, [qc])

  // Load data that needs an unlocked vault.
  useEffect(() => {
    if (!vault?.unlocked) return
    const s = useApp.getState()
    api.transfers
      .list()
      .then(s.setJobs)
      .catch(() => undefined)
    api.docker
      .status()
      .then(s.setDocker)
      .catch(() => undefined)
    const t = setInterval(
      () =>
        api.docker
          .status()
          .then(useApp.getState().setDocker)
          .catch(() => undefined),
      15_000
    )
    return () => clearInterval(t)
  }, [vault?.unlocked])

  if (!vault || !prefs) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }

  return (
    <>
      {!vault.unlocked ? (
        <LoginPage />
      ) : (
        <Routes>
          <Route element={<Layout />}>
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/registries" element={<RegistriesPage />} />
            <Route path="/local" element={<LocalImagesPage />} />
            <Route path="/transfers" element={<TransfersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/preferences" element={<PreferencesPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="*" element={<Navigate to={`/${prefs.startupPage}`} replace />} />
          </Route>
        </Routes>
      )}
      <ConfirmHost />
      <Toasts />
    </>
  )
}
