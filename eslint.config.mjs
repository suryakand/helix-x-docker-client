import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// Single flat config for the whole monorepo; each workspace runs `eslint .` and picks this up.
export default tseslint.config(
  {
    ignores: [
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/test-results/**',
      // Vite writes (and deletes) these next to the config while `build` runs in parallel with `lint`.
      '**/*.timestamp-*.mjs'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,mjs}'],
    ignores: ['apps/desktop/src/renderer/**'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
)
