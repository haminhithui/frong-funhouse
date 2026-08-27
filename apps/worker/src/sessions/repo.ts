/**
 * Worker-side D1 repository adapter — GAME SESSIONS.
 *
 * Scope: create/read/consume durable game sessions using the existing
 * `sessions` schema from `migrations/0001_init.sql`. Not wired to any HTTP
 * route yet (src/index.ts unchanged); later phases inject this repo.
 *
 * Semantics:
 *   * create  — one session per consumed payment (UNIQUE (payment_id)); the
 *               row is bound to the wallet that owns the payment
 *               (payments.player) and starts 'active'.
 *   * get     — read by session id; lazily transitions an 'active' row whose
 *               expires_at has passed to 'expired' (guarded single UPDATE),
 *               keeping the stored status truthful between expiry sweeps.
 *   * consume — one-time transition 'active' -> 'consumed', guarded on owner
 *               (player), status, AND expiry in ONE statement, so a session
 *               can never be consumed twice, by the wrong wallet, or after
 *               expiry — even under interleaved attempts.
 *
 * Atomicity strategy (single statements, no D1 batch needed):
 *   Every state change is one guarded `INSERT|UPDATE ... RETURNING`. The
 *   UNIQUE (payment_id) index is the create backstop (exactly one session per
 *   payment), the consume WHERE clause is the one-time backstop, and D1
 *   serializes writes (single writer), so concurrent attempts resolve
 *   deterministically to one `accepted` plus `already_consumed` replays.
 *
 * D1 API notes (same constraints as src/payments/repo.ts, whose pattern this
 * adapter reuses without modifying it):
 *   * D1 rejects explicit BEGIN/COMMIT via prepare(); batch() is the only
 *     transaction primitive. Guards keep each transition in ONE statement,
 *     so no batch is required.
 *   * `meta.changes` typing varies across workers-types versions, so outcomes
 *     are read from RETURNING + first() instead (`first()` yields null when
 *     a guard skipped the write).
 *
 * Timestamps: ISO-8601 UTC strings (Date.toISOString()), matching the TEXT
 * columns. SQL comparisons (expires_at > ?) are lexicographic, which is exact
 * for this canonical format; TS-side checks parse dates so they also tolerate
 * equivalent spellings. A session is valid strictly until expires_at: at
 * exactly expires_at it is already expired.
 */

/** Minimal structural slice of D1 used here (mirrors src/payments/repo.ts;
 * the real `D1Database`/`D1PreparedStatement` from @cloudflare/workers-types
 * are assignable to these, and unit tests inject an in-memory fake). */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: unknown }>
  run<T = Record<string, unknown>>(): Promise<{ results?: T[]; meta?: unknown }>
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike
}

export type SessionStatus = 'active' | 'completed' | 'expired' | 'consumed'

export interface SessionRecord {
  sessionId: string
  paymentId: string
  player: string
  seed: number
  buildHash: string
  status: SessionStatus
  createdAt: string
  expiresAt: string
  consumedAt: string | null
  updatedAt: string
}

export interface CreateSessionInput {
  /** Existing payments.id the session is minted from; must be status
   * 'consumed' and owned by `player` (schema: "bound to a consumed payment"). */
  paymentId: string
  /** 0x-prefixed 20-byte wallet (42 chars); must equal payments.player. */
  player: string
  /** Deterministic game seed; non-negative safe integer (schema CHECK >= 0). */
  seed: number
  /** Client build identifier; non-empty (schema CHECK). */
  buildHash: string
  /** ISO-8601 UTC instant the session stops being consumable; must be after
   * `at` (a create that is already expired is a caller bug and throws). */
  expiresAt: string
  /** ISO-8601 clock used for created_at/updated_at stamps; defaults to now. */
  at?: string
}

export interface ConsumeSessionInput {
  /** sessions.session_id of the session to consume. */
  sessionId: string
  /** Consuming wallet; must equal the session's bound player. */
  player: string
  /** ISO-8601 clock used for expiry comparison and stamps; defaults to now. */
  at?: string
}

export interface GetSessionOptions {
  /** When set, only the owning wallet sees the row; other wallets get null. */
  player?: string
  /** ISO-8601 clock for the lazy expiry transition; defaults to now. */
  at?: string
}

export type CreateSessionResult =
  /** This call inserted the session (status 'active'). */
  | { outcome: 'created'; record: SessionRecord }
  /** UNIQUE (payment_id): a session already exists for this payment; `record`
   * is the stored first-write-wins truth, so replays return identical
   * records. */
  | { outcome: 'already_exists'; record: SessionRecord }
  /** The insert guard rejected the payment: no payments row with this id
   * (paymentStatus/paymentPlayer null), the payment belongs to another
   * wallet (paymentPlayer differs from the input), or its status is not
   * 'consumed' (paymentStatus shows the stored status). */
  | { outcome: 'payment_not_consumed'; paymentStatus: string | null; paymentPlayer: string | null }

export type ConsumeSessionResult =
  /** This call atomically performed the one-time consumption. */
  | { outcome: 'accepted'; record: SessionRecord }
  /** The stored session is already consumed; `record` is the first-write-wins
   * truth (original consumed_at), so replays return identical records. */
  | { outcome: 'already_consumed'; record: SessionRecord }
  /** The session exists but is bound to another wallet; `record` is the
   * stored owner's row. Nothing was consumed. */
  | { outcome: 'wrong_player'; record: SessionRecord }
  /** The session is past expires_at (stored 'expired', or 'active' but past
   * expiry at `at`). Nothing was consumed. */
  | { outcome: 'expired'; record: SessionRecord }
  /** The session is in a terminal non-consumable state ('completed'). */
  | { outcome: 'not_consumable'; record: SessionRecord }
  /** No session with this id. */
  | { outcome: 'not_found'; record: null }

export interface SessionsRepo {
  /** Create one session bound to a consumed payment; never a duplicate row. */
  create(input: CreateSessionInput): Promise<CreateSessionResult>
  /** Read a session by id (owner-filtered via options); lazily expires. */
  get(sessionId: string, options?: GetSessionOptions): Promise<SessionRecord | null>
  /** One-time atomic consumption guarded on owner, status, and expiry. */
  consume(input: ConsumeSessionInput): Promise<ConsumeSessionResult>
}

const COLUMNS = `
  session_id AS sessionId, payment_id AS paymentId, player, seed,
  build_hash AS buildHash, status, created_at AS createdAt,
  expires_at AS expiresAt, consumed_at AS consumedAt, updated_at AS updatedAt
`

/** Insert one session per consumed payment. The SELECT guard binds the row to
 * the payment owner and requires status 'consumed'; ON CONFLICT (payment_id)
 * DO NOTHING makes replay deterministic instead of throwing. The SELECT ends
 * with a WHERE clause so SQLite's upsert parsing is unambiguous. */
const INSERT_SQL = `
  INSERT INTO sessions (
    session_id, payment_id, player, seed, build_hash, status,
    created_at, expires_at, updated_at
  )
  SELECT ?, p.id, ?, ?, ?, 'active', ?, ?, ?
  FROM payments p
  WHERE p.id = ? AND p.player = ? AND p.status = 'consumed'
  ON CONFLICT (payment_id) DO NOTHING
  RETURNING ${COLUMNS}
`

const SELECT_BY_ID_SQL = `
  SELECT ${COLUMNS} FROM sessions WHERE session_id = ?
`

const SELECT_BY_PAYMENT_SQL = `
  SELECT ${COLUMNS} FROM sessions WHERE payment_id = ?
`

/** Payment diagnostics for a create whose insert guard skipped the write. */
const SELECT_PAYMENT_SQL = `
  SELECT player, status FROM payments WHERE id = ?
`

/** Lazily transition a passed-expiry active row; the guard makes the
 * transition idempotent and race-free (only one UPDATE can win). */
const EXPIRE_SQL = `
  UPDATE sessions SET status = 'expired', updated_at = ?
  WHERE session_id = ? AND status = 'active' AND expires_at <= ?
  RETURNING ${COLUMNS}
`

/** One-time consumption: all three guards (owner, status, expiry) live in the
 * single WHERE clause, so no interleaving can consume a session twice. */
const CONSUME_SQL = `
  UPDATE sessions SET
    status = 'consumed',
    consumed_at = ?,
    updated_at = ?
  WHERE session_id = ?
    AND player = ?
    AND status = 'active'
    AND expires_at > ?
  RETURNING ${COLUMNS}
`

const STATUSES: readonly SessionStatus[] = ['active', 'completed', 'expired', 'consumed']

function readStatus(value: unknown): SessionStatus {
  if (typeof value === 'string' && (STATUSES as readonly string[]).includes(value)) {
    return value as SessionStatus
  }
  throw new Error(`sessions repo: unexpected status in row: ${String(value)}`)
}

function toRecord(row: Record<string, unknown> | null | undefined): SessionRecord | null {
  if (row == null) return null
  return {
    sessionId: String(row.sessionId),
    paymentId: String(row.paymentId),
    player: String(row.player),
    seed: Number(row.seed),
    buildHash: String(row.buildHash),
    status: readStatus(row.status),
    createdAt: String(row.createdAt ?? ''),
    expiresAt: String(row.expiresAt ?? ''),
    consumedAt: row.consumedAt == null ? null : String(row.consumedAt),
    updatedAt: String(row.updatedAt ?? ''),
  }
}

/** Valid strictly until expires_at: expired once expires_at <= at. Prefers
 * Date.parse (format-tolerant); falls back to the lexicographic TEXT order
 * the SQL guards use when either side is not a parseable date. */
function isExpiredAt(expiresAt: string, at: string): boolean {
  const e = Date.parse(expiresAt)
  const a = Date.parse(at)
  if (Number.isNaN(e) || Number.isNaN(a)) return expiresAt <= at
  return e <= a
}

/** crypto.randomUUID without depending on ambient Workers/DOM typings. */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  throw new Error('sessions repo: crypto.randomUUID is unavailable')
}

function nowIso(): string {
  return new Date().toISOString()
}

export function createSessionsRepo(db: D1DatabaseLike): SessionsRepo {
  /** Explain a skipped create from stored rows (read-only, like the payments
   * repo's classify). Infrastructure errors here propagate naturally; only
   * the null-insert path reaches this function. */
  async function classifyCreate(input: CreateSessionInput): Promise<CreateSessionResult> {
    const existing = toRecord(
      await db.prepare(SELECT_BY_PAYMENT_SQL).bind(input.paymentId).first(),
    )
    if (existing && existing.player === input.player) {
      return { outcome: 'already_exists', record: existing }
    }
    // No session for this caller: either none exists at all, or it/payment is
    // owned by another wallet — the payment row disambiguates.
    const payment = (await db.prepare(SELECT_PAYMENT_SQL).bind(input.paymentId).first()) as {
      player?: unknown
      status?: unknown
    } | null
    return {
      outcome: 'payment_not_consumed',
      paymentStatus: payment == null || payment.status == null ? null : String(payment.status),
      paymentPlayer: payment == null || payment.player == null ? null : String(payment.player),
    }
  }

  /** Explain a skipped consume from the stored row (read-only). */
  async function classifyConsume(
    input: ConsumeSessionInput,
    at: string,
  ): Promise<Exclude<ConsumeSessionResult, { outcome: 'accepted' }>> {
    const stored = toRecord(await db.prepare(SELECT_BY_ID_SQL).bind(input.sessionId).first())
    if (!stored) return { outcome: 'not_found', record: null }
    if (stored.player !== input.player) return { outcome: 'wrong_player', record: stored }
    if (stored.status === 'consumed') return { outcome: 'already_consumed', record: stored }
    if (stored.status === 'expired' || isExpiredAt(stored.expiresAt, at)) {
      return { outcome: 'expired', record: stored }
    }
    return { outcome: 'not_consumable', record: stored }
  }

  return {
    async create(input: CreateSessionInput): Promise<CreateSessionResult> {
      const at = input.at ?? nowIso()
      // Caller bugs are rejected before SQL (the schema has no expiry CHECK
      // and a REAL seed would not trip the INTEGER CHECK).
      if (!Number.isSafeInteger(input.seed) || input.seed < 0) {
        throw new TypeError(`sessions repo: seed must be a non-negative safe integer: ${input.seed}`)
      }
      if (isExpiredAt(input.expiresAt, at)) {
        throw new RangeError(
          `sessions repo: expiresAt (${input.expiresAt}) must be after at (${at})`,
        )
      }
      const inserted = await db
        .prepare(INSERT_SQL)
        .bind(
          newId(),
          input.player,
          input.seed,
          input.buildHash,
          at,
          input.expiresAt,
          at,
          input.paymentId,
          input.player,
        )
        .first()
      if (inserted) {
        const record = toRecord(inserted)
        if (!record) throw new Error('sessions repo: insert returned an unmappable row')
        return { outcome: 'created', record }
      }
      return classifyCreate(input)
    },

    async get(
      sessionId: string,
      options?: GetSessionOptions,
    ): Promise<SessionRecord | null> {
      const at = options?.at ?? nowIso()
      let record = toRecord(await db.prepare(SELECT_BY_ID_SQL).bind(sessionId).first())
      if (!record) return null
      if (options?.player !== undefined && record.player !== options.player) return null
      if (record.status === 'active' && isExpiredAt(record.expiresAt, at)) {
        // Lost the transition race (another reader/sweep won): re-read.
        const transitioned = toRecord(
          await db.prepare(EXPIRE_SQL).bind(at, sessionId, at).first(),
        )
        record = transitioned ?? toRecord(await db.prepare(SELECT_BY_ID_SQL).bind(sessionId).first()) ?? record
      }
      return record
    },

    async consume(input: ConsumeSessionInput): Promise<ConsumeSessionResult> {
      const at = input.at ?? nowIso()
      const updated = await db
        .prepare(CONSUME_SQL)
        .bind(at, at, input.sessionId, input.player, at)
        .first()
      if (updated) {
        const record = toRecord(updated)
        if (!record) throw new Error('sessions repo: consume returned an unmappable row')
        return { outcome: 'accepted', record }
      }
      return classifyConsume(input, at)
    },
  }
}
