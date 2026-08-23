import { randomBytes } from 'node:crypto'

export interface Session {
  sessionId: string
  player: string
  paymentTxHash: string
  /** Present for sessions issued through payment recovery; optional for legacy callers. */
  paymentId?: string
  seed: number
  buildHash: string
  createdAt: number
  expiresAt: number
  consumed: boolean
}

/** Session material is durably bound to a payment by Store; the map is a hot cache. */
export const SESSION_PERSISTENCE_SCOPE = 'durable-payment-binding' as const

const sessions = new Map<string, Session>()

function prune(): void {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id)
  }
}

/** Issues a seed-bound session for a validated payment. One session per payment. */
export function issueSession(
  player: string,
  paymentTxHash: string,
  buildHash: string,
  ttlMs: number,
  options: { paymentId?: string } = {},
): Session {
  prune()
  const now = Date.now()
  const session: Session = {
    sessionId: randomBytes(16).toString('hex'),
    player: player.toLowerCase(),
    paymentTxHash: paymentTxHash.toLowerCase(),
    ...(options.paymentId ? { paymentId: options.paymentId.toLowerCase() } : {}),
    seed: randomBytes(4).readUInt32BE(0) >>> 0,
    buildHash,
    createdAt: now,
    expiresAt: now + ttlMs,
    consumed: false,
  }
  sessions.set(session.sessionId, session)
  return session
}

/**
 * Rehydrates a session from a durable payment binding after a restart. The
 * original expiry is honored; this never extends a paid run's lifetime.
 */
export function restoreSession(
  recovered: Omit<Session, 'consumed'> & { consumed?: boolean },
): Session | undefined {
  prune()
  if (recovered.expiresAt <= Date.now()) return undefined
  const existing = sessions.get(recovered.sessionId)
  if (existing) {
    if (
      existing.player !== recovered.player.toLowerCase() ||
      existing.paymentTxHash !== recovered.paymentTxHash.toLowerCase() ||
      existing.buildHash !== recovered.buildHash
    ) {
      return undefined
    }
    return existing
  }
  const session: Session = {
    ...recovered,
    player: recovered.player.toLowerCase(),
    paymentTxHash: recovered.paymentTxHash.toLowerCase(),
    ...(recovered.paymentId ? { paymentId: recovered.paymentId.toLowerCase() } : {}),
    consumed: recovered.consumed ?? false,
  }
  sessions.set(session.sessionId, session)
  return session
}

export function getSession(sessionId: string): Session | undefined {
  prune()
  const session = sessions.get(sessionId)
  if (!session) return undefined
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId)
    return undefined
  }
  return session
}

/** Marks a session consumed (one accepted submission per session). */
export function consumeSession(sessionId: string): boolean {
  const session = getSession(sessionId)
  if (!session || session.consumed) return false
  session.consumed = true
  return true
}
