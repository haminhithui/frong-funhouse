/**
 * Build-integrity check: the client's build-time sim hash (embedded via the
 * vite.config define) must equal the server's canonical sim build hash
 * (apps/server/src/simBuildHash.ts). Reuses the EXISTING algorithms - it
 * computes nothing new. Prints only the public hash prefix; no secrets.
 * Run with tsx so the TS imports resolve: `tsx scripts/check-sim-hash.mjs`
 */
import { computeSimBuildHash } from '../apps/server/src/simBuildHash.ts'
import viteConfig from '../vite.config.ts'

const serverHash = computeSimBuildHash()
const config = viteConfig && 'default' in viteConfig ? viteConfig.default : viteConfig
const define = config.define ?? {}
const embeddedRaw = define['import.meta.env.VITE_SIM_BUILD_HASH']
if (typeof embeddedRaw !== 'string') {
  console.error('check-sim-hash: vite define for VITE_SIM_BUILD_HASH is missing')
  process.exit(1)
}
let embedded
try {
  embedded = JSON.parse(embeddedRaw)
} catch {
  console.error('check-sim-hash: vite define value is not valid JSON')
  process.exit(1)
}
if (embedded !== serverHash) {
  console.error('check-sim-hash: MISMATCH between the client build hash and the server sim hash')
  console.error('  embedded (vite define):', embedded)
  console.error('  canonical (server)    :', serverHash)
  process.exit(1)
}
console.log('check-sim-hash: consistent (' + serverHash.slice(0, 16) + '...)')
