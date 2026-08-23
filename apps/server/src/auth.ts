import { createHash, randomBytes } from 'node:crypto'

export interface AuthToken {
  address: string
  expiresAt: number
}

/**
 * Durable auth storage is injected by the server. The in-memory adapter is
 * retained for isolated unit tests and callers that explicitly opt out.
 */
export interface AuthTokenPersistence {
  putAuthToken(tokenHash: string, record: AuthToken): void
  getAuthToken(tokenHash: string): AuthToken | undefined
  pruneAuthTokens(now: number): void
}

export const AUTH_TOKEN_PERSISTENCE_SCOPE = 'durable-adapter' as const

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
  persistence?: AuthTokenPersistence,
): { token: string; expiresAt: number } {
  if (persistence) persistence.pruneAuthTokens(Date.now())
  else prune()
  const token = randomBytes(32).toString('hex')
  const expiresAt = Date.now() + ttlMs
  const record = { address: address.toLowerCase(), expiresAt }
  if (persistence) {
    // Persist only a digest. A data-directory read must never reveal a live
    // bearer token that can be replayed against the API.
    persistence.putAuthToken(hashToken(token), record)
  } else {
    tokens.set(token, record)
  }
  return { token, expiresAt }
}

/** Resolves the address behind a Bearer token, or null. */
export function resolveAuth(
  header: string | undefined,
  persistence?: AuthTokenPersistence,
): string | null {
  if (persistence) persistence.pruneAuthTokens(Date.now())
  else prune()
  if (!header || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  if (!/^[0-9a-f]{64}$/.test(token) && !/^[0-9a-f]{64}$/.test(token.toLowerCase())) {
    return null
  }
  const auth = persistence ? persistence.getAuthToken(hashToken(token)) : tokens.get(token)
  if (!auth) return null
  if (auth.expiresAt <= Date.now()) return null
  return auth.address
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
