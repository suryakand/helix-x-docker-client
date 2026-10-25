import { defineConfig } from 'playwright/test'

export default defineConfig({
  testDir: '.',
  // Downloads the Electron binary once before workers start (see global-setup.ts).
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' }
})
