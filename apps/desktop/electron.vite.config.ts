import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Everything (including @helix/core, @helix/shared and their npm dependencies) is bundled into out/,
// so the packaged app ships no node_modules. That keeps electron-builder independent of pnpm's
// symlinked node_modules layout and makes installers smaller.
export default defineConfig({
  main: {
    build: { externalizeDeps: false }
  },
  preload: {
    // Sandboxed preload scripts cannot require node_modules either.
    build: { externalizeDeps: false }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
})
