import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The shared deterministic simulation (root src/game/sim) is version-pinned by
 * this build hash. The server embeds it in every session and every on-chain
 * attestation; a client can only claim a score for the exact sim build the
 * server replays. Any gameplay change to the sim changes the hash — that is a
 * deliberate, versioned change, not an accident.
 */
const SIM_DIR = join(__dirname, '..', '..', '..', 'src', 'game', 'sim')

export function computeSimBuildHash(): string {
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
