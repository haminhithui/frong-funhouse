/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time sim build hash (define in vite.config.ts) - matches the server's buildHash. */
  readonly VITE_SIM_BUILD_HASH?: string
}
