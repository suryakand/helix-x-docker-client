import { defineConfig } from 'playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' }
})
