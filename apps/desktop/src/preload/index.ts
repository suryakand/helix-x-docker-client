import { contextBridge, ipcRenderer } from 'electron'
import { API_SHAPE } from '@helix/shared/channels'
import { EVENT_CHANNEL, type HelixBridge, type IpcResult } from '@helix/shared/api'
import type { AppEvent } from '@helix/shared/types'

async function call(channel: string, args: unknown[]): Promise<unknown> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<unknown>
  if (res.ok) return res.data
  const err = new Error(res.error.message)
  ;(err as Error & { code?: string }).code = res.error.code
  throw err
}

const bridge: Record<string, unknown> = {}
for (const [ns, methods] of Object.entries(API_SHAPE)) {
  const group: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of methods) {
    group[method] = (...args: unknown[]) => call(`${ns}.${method}`, args)
  }
  bridge[ns] = group
}

bridge.onEvent = (listener: (event: AppEvent) => void) => {
  const handler = (_e: Electron.IpcRendererEvent, event: AppEvent) => listener(event)
  ipcRenderer.on(EVENT_CHANNEL, handler)
  return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler)
}

contextBridge.exposeInMainWorld('helix', bridge as unknown as HelixBridge)
