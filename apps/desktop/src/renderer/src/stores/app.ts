import { create } from 'zustand'
import type { DockerStatus, Job, Preferences, VaultStatus } from '@helix/shared/types'

interface Toast {
  id: number
  message: string
  tone: 'info' | 'success' | 'error'
}

interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

interface AppState {
  vault?: VaultStatus
  docker?: DockerStatus
  prefs?: Preferences
  activeRegistryId?: string
  jobs: Record<string, Job>
  toasts: Toast[]
  confirm?: ConfirmRequest
  setVault(v: VaultStatus): void
  setDocker(d: DockerStatus): void
  setPrefs(p: Preferences): void
  setActiveRegistry(id: string | undefined): void
  upsertJob(j: Job): void
  removeJob(id: string): void
  setJobs(jobs: Job[]): void
  toast(message: string, tone?: Toast['tone']): void
  dismissToast(id: number): void
  ask(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean>
  closeConfirm(ok: boolean): void
}

let toastId = 0

export const useApp = create<AppState>((set, get) => ({
  jobs: {},
  toasts: [],
  setVault: (vault) => set({ vault }),
  setDocker: (docker) => set({ docker }),
  setPrefs: (prefs) => set({ prefs }),
  setActiveRegistry: (activeRegistryId) => {
    set({ activeRegistryId })
    try {
      if (activeRegistryId) localStorage.setItem('activeRegistryId', activeRegistryId)
    } catch {
      /* storage may be unavailable */
    }
  },
  upsertJob: (j) => set((s) => ({ jobs: { ...s.jobs, [j.id]: j } })),
  removeJob: (id) =>
    set((s) => {
      const jobs = { ...s.jobs }
      delete jobs[id]
      return { jobs }
    }),
  setJobs: (list) => set({ jobs: Object.fromEntries(list.map((j) => [j.id, j])) }),
  toast: (message, tone = 'info') => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }))
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  ask: (req) =>
    new Promise<boolean>((resolve) => {
      set({ confirm: { ...req, resolve } })
    }),
  closeConfirm: (ok) => {
    get().confirm?.resolve(ok)
    set({ confirm: undefined })
  }
}))

export function rememberedRegistryId(): string | undefined {
  try {
    return localStorage.getItem('activeRegistryId') ?? undefined
  } catch {
    return undefined
  }
}

/** Confirm destructive actions unless the user turned confirmations off in Preferences. */
export async function confirmAction(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  const { prefs, ask } = useApp.getState()
  if (prefs && !prefs.confirmDeletes) return true
  return ask(req)
}
