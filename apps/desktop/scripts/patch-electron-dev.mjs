#!/usr/bin/env node
// macOS only: renames the local dev Electron.app to the product name and gives it the app icon, so
// `pnpm dev` shows "Helix-X Docker Client" (not "Electron") in the menu bar, Dock and app switcher.
// macOS reads these from the bundle's Info.plist, which the app cannot change at runtime.
// Packaged builds are unaffected; reinstalling electron undoes the patch and the next run re-applies it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const root = resolve(import.meta.dirname, '..')
const productName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).productName
// require('electron') returns the binary: .../Electron.app/Contents/MacOS/Electron
const appBundle = resolve(createRequire(join(root, 'package.json'))('electron'), '../../..')
const plist = join(appBundle, 'Contents/Info.plist')
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let current = ''
try {
  current = run('plutil', ['-extract', 'CFBundleName', 'raw', plist]).trim()
} catch {
  // missing key: patch below
}
if (current === productName) process.exit(0)

try {
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    run('plutil', ['-replace', key, '-string', productName, plist])
  }

  // Build an .icns from resources/icon.png and replace Electron's.
  const tmp = mkdtempSync(join(tmpdir(), 'helix-icon-'))
  const iconset = join(tmp, 'icon.iconset')
  run('mkdir', [iconset])
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      const px = String(size * scale)
      run('sips', ['-z', px, px, join(root, 'resources/icon.png'), '--out', join(iconset, name)])
    }
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(appBundle, 'Contents/Resources/electron.icns')])
  rmSync(tmp, { recursive: true, force: true })

  // Editing Info.plist breaks the bundle's signature; re-sign ad hoc so it still launches.
  run('codesign', ['--force', '--deep', '--sign', '-', appBundle])
  // Ask Launch Services to pick up the new name and icon.
  run('touch', [appBundle])
  console.log(`Patched ${appBundle} as "${productName}"`)
} catch (err) {
  // Never block `pnpm dev`: worst case the Dock shows "Electron".
  console.warn(`Could not patch the dev Electron.app: ${err.stderr || err.message}`)
}
