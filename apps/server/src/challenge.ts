import { randomBytes } from 'node:crypto'
import { recoverMessageAddress } from 'viem'

export interface Challenge {
  address: string
  nonce: string
  message: string
  issuedAt: string
  expiresAt: number
}

const challenges = new Map<string, Challenge>()

const CHALLENGE_TTL_MS = 5 * 60 * 1000

function prune(): void {
  const now = Date.now()
  for (const [nonce, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(nonce)
  }
}

export function challengeMessage(
  address: string,
  nonce: string,
  issuedAt: string,
  chainId: number,
): string {
  return [
    'frong-catch.fan wants you to sign in with your wallet.',
    '',
    'Address: ' + address,
    'Nonce: ' + nonce,
    'Issued At: ' + issuedAt,
    'Chain ID: ' + chainId,
  ].join('\n')
}

/** Issues a one-time SIWE-style challenge for the address. */
export function issueChallenge(address: string, chainId: number): Challenge {
  prune()
  const nonce = randomBytes(16).toString('hex')
  const issuedAt = new Date().toISOString()
  const challenge: Challenge = {
    address: address.toLowerCase(),
    nonce,
    message: challengeMessage(address, nonce, issuedAt, chainId),
    issuedAt,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  }
  challenges.set(nonce, challenge)
  return challenge
}

/**
 * Verifies the signature over the exact challenge message. Returns the
 * recovered address on success (null otherwise). The nonce is single-use.
 */
export async function verifyChallenge(
  address: string,
  nonce: string,
  signature: string,
): Promise<string | null> {
  prune()
  const challenge = challenges.get(nonce)
  if (!challenge) return null
  if (challenge.address !== address.toLowerCase()) return null
  try {
    const recovered = await recoverMessageAddress({
      message: challenge.message,
      signature: signature as `0x${string}`,
    })
    if (recovered.toLowerCase() !== address.toLowerCase()) return null
    challenges.delete(nonce)
    return recovered
  } catch {
    return null
  }
}
