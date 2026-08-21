import { createHash } from 'node:crypto'
import type { Hex } from 'viem'
import { TIERS, tierForScore } from '../../../src/game/sim/constants'
import type { ServerConfig } from './config'

export const TIER_SLUGS = [
  'tadpole',
  'pond-hopper',
  'fly-snatcher',
  'lily-legend',
  'just-frong',
  'not-wrong',
] as const

/**
 * Rarity is backend-decided and skill-gated: the tier comes from the
 * replay-verified score via the shared tier table. There is no random roll,
 * no Chainlink, no VRF — the backend is the sole authority and the mapping is
 * server-side configuration (TIERS in the shared sim package).
 */
export function tierForVerifiedScore(score: number): { index: number; name: string; slug: string } {
  const index = tierForScore(score)
  return { index, name: TIERS[index].name, slug: TIER_SLUGS[index] }
}

/** sha256 commitment to the run seed — engraved in the on-chain attestation. */
export function seedCommitment(seed: number): string {
  return createHash('sha256').update(String(seed)).digest('hex')
}

export interface TrophyMetadata {
  name: string
  description: string
  image: string
  attributes: { trait_type: string; value: string | number }[]
}

export function buildMetadata(
  config: ServerConfig,
  tokenId: number,
  tier: { index: number; name: string; slug: string },
  score: number,
  fliesCaught: number,
  seedCommitmentHex: string,
): { json: TrophyMetadata; uri: string } {
  const json: TrophyMetadata = {
    name: 'FRONG Catch Trophy #' + tokenId + ' — ' + tier.name,
    description:
      'Replay-verified FRONG Catch run: ' +
      score +
      '/109 points, ' +
      fliesCaught +
      '/45 flies. Tier: ' +
      tier.name +
      '.',
    image: config.metadataBaseUrl + '/assets/tiers/' + tier.slug + '.png',
    attributes: [
      { trait_type: 'Tier', value: tier.name },
      { trait_type: 'Score', value: score },
      { trait_type: 'Flies Caught', value: fliesCaught },
      { trait_type: 'Seed Commitment', value: seedCommitmentHex },
    ],
  }
  return { json, uri: config.metadataBaseUrl + '/metadata/' + tokenId + '.json' }
}

export interface ChainAttestation {
  tier: number
  score: number
  fliesCaught: number
  seedCommitment: Hex
  inputLogHash: Hex
  timestamp: bigint
  buildHash: Hex
}

export function toChainAttestation(
  tierIndex: number,
  score: number,
  fliesCaught: number,
  seedCommitmentHex: string,
  inputLogHash: string,
  buildHash: string,
): ChainAttestation {
  return {
    tier: tierIndex,
    score,
    fliesCaught,
    seedCommitment: ('0x' + seedCommitmentHex) as Hex,
    inputLogHash: ('0x' + inputLogHash) as Hex,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    buildHash: ('0x' + buildHash) as Hex,
  }
}
