/// <reference types="vite/client" />
import type { HelixBridge } from '@helix/shared/api'

declare global {
  interface Window {
    /** Typed API exposed by src/preload/index.ts. */
    helix: HelixBridge
  }
}

export {}
