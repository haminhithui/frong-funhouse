import { randomBytes } from 'node:crypto'

export interface Session {
  sessionId: string
  player: string
  paymentTxHash: string
  seed: number
  buildHash: string
  createdAt: number
  expiresAt: number
  consumed: boolean
}

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
): Session {
  prune()
  const session: Session = {
    sessionId: randomBytes(16).toString('hex'),
    player: player.toLowerCase(),
    paymentTxHash: paymentTxHash.toLowerCase(),
    seed: randomBytes(4).readUInt32BE(0) >>> 0,
    buildHash,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    consumed: false,
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
