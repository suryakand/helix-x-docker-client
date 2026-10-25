import { createRequire } from 'node:module'

/**
 * Electron (>= 36) has no install script: it downloads its binary the first time `require('electron')` runs.
 * Playwright resolves it in every worker, so on a fresh machine (CI) the workers download and unpack the
 * same files concurrently and one launches a half-written binary (`spawn ETXTBSY` on Linux, "File exists"
 * on macOS). Resolving it once here, before any worker starts, makes the download happen exactly once.
 */
export default function globalSetup(): void {
  if (process.env.HELIX_E2E_EXECUTABLE) return // testing a packaged app; the npm Electron binary is not used
  const electronPath = createRequire(__filename)('electron') as string
  if (typeof electronPath !== 'string' || !electronPath) throw new Error('Electron binary is not available')
}
