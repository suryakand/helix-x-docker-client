import { defineConfig } from 'vitest/config'

// Used by scripts/integration.mjs, which starts the registry containers and sets HELIX_IT_* variables.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
})
