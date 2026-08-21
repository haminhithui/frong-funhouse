import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const SIM_DIR = fileURLToPath(new URL('./src/game/sim', import.meta.url))

/**
 * Canonical sim build hash — MUST match apps/server/src/simBuildHash.ts
 * exactly: sorted *.ts filenames in src/game/sim, sha256 over
 * name + '\u0000' + content + '\u0000', hex digest. Computed at BUILD TIME
 * so the client can only claim a score for the exact sim build the server
 * replays.
 */
function computeSimBuildHash(): string {
  const files = readdirSync(SIM_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
  const hash = createHash('sha256')
  for (const name of files) {
    hash.update(name)
    hash.update('\u0000')
    hash.update(readFileSync(join(SIM_DIR, name), 'utf8'))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

const simBuildHash = computeSimBuildHash()

export default defineConfig({
  define: {
    __SIM_BUILD_HASH__: JSON.stringify(simBuildHash),
    'import.meta.env.VITE_SIM_BUILD_HASH': JSON.stringify(simBuildHash),
  },
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 8080,
    strictPort: true,
    watch: {
      // Atomic-write temp dirs from editor/tooling cause EBUSY watcher crashes
      // on Windows; they are never project sources.
      ignored: ['**/.*.tmpdir/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    // Production builds ship without sourcemaps so the full source is not
    // published alongside the bundle (hosted dist/ is a public artifact).
    sourcemap: false,
    // Two deployment artifacts from one repo:
    // - the fan site (index.html) with the free practice arcade embedded,
    // - the paid game app (paid/index.html) with wallet + FRONG entry flow.
    // The fan-site bundle never imports wallet code.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        paid: fileURLToPath(new URL('./paid/index.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Serial execution: the game suites drive real rAF wall-clock loops and
    // become flaky when file workers compete for CPU in parallel.
    fileParallelism: false,
    // The contracts package (Hardhat/mocha) and the server package (own
    // vitest project) run their own suites — never under the root project.
    exclude: ['**/node_modules/**', '**/dist/**', 'contracts/**', 'apps/**'],
  },
})
