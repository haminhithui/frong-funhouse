import { randomBytes } from 'node:crypto'

interface AuthToken {
  address: string
  expiresAt: number
}

const tokens = new Map<string, AuthToken>()

function prune(): void {
  const now = Date.now()
  for (const [token, auth] of tokens) {
    if (auth.expiresAt <= now) tokens.delete(token)
  }
}

/** Issues a short-lived opaque auth token bound to the verified address. */
export function issueAuthToken(
  address: string,
  ttlMs: number,
): { token: string; expiresAt: number } {
  prune()
  const token = randomBytes(32).toString('hex')
  tokens.set(token, { address: address.toLowerCase(), expiresAt: Date.now() + ttlMs })
  return { token, expiresAt: Date.now() + ttlMs }
}

/** Resolves the address behind a Bearer token, or null. */
export function resolveAuth(header: string | undefined): string | null {
  prune()
  if (!header || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  const auth = tokens.get(token)
  if (!auth) return null
  return auth.address
}
