#!/usr/bin/env node
// Remove build output, caches and test artifacts from every workspace.
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const targets = [
  '.turbo',
  'apps/desktop/out',
  'apps/desktop/release',
  'apps/desktop/test-results',
  'apps/desktop/playwright-report',
  'apps/desktop/.turbo',
  'packages/core/.turbo',
  'packages/core/tests/integration/.tmp',
  'packages/shared/.turbo'
]
for (const t of targets) rmSync(resolve(root, t), { recursive: true, force: true })
console.log('Cleaned build output')
