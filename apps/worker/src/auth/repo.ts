/**
 * Worker-side D1 repository adapter — WALLET CHALLENGES + HASHED AUTH TOKENS.
 *
 * Scope: durable auth state foundation on the `wallet_challenges` and
 * `auth_tokens` schema from `migrations/0002_auth.sql`.
 * Not wired to any HTTP route or Privy SDK yet (src/index.ts unchanged);
 * later phases inject this repo after verifying signatures in-flight.
 *
 * SECURITY CONTRACT (enforced at this boundary):
 *   * Every digest parameter (`challengeHash`, `tokenHash`) must already be
 *     a SHA-256 hex digest computed by the caller. The repo validates the
 *     64-hex format and REJECTS anything else with a TypeError before SQL,
 *     so a raw bearer token, wallet signature, or private key can never be
 *     persisted through these columns — the schema's length CHECK is the
 *     second line of defense, the absence of any other column the third.
 *   * Lookups are by opaque row ids or digests only. No method accepts or
 *     returns raw credentials.
 *
 * Semantics:
 *   * issueChallenge — one pending challenge per digest (UNIQUE
 *     (challenge_hash)); a replay returns the stored first-write-wins row.
 *   * getChallenge — read by opaque id (owner-filtered); lazily transitions
 *     a pending row past expires_at to 'expired' (guarded single UPDATE).
 *   * consumeChallenge — one-time 'pending' -> 'consumed' transition guarded
 *     on owner AND status AND expiry in ONE statement; optionally binds the
 *     one payment this challenge authorized (UNIQUE (payment_id) across
 *     challenges is the duplicate-binding backstop).
 *   * issueToken — one active token row per digest; UNIQUE (challenge_id)
 *     and UNIQUE (payment_id) make "one token per challenge/payment"
 *     idempotent, so a retry resolves to the ORIGINAL token's row.
 *   * resolveToken — bearer verification: point lookup by digest, wallet
 *     binding via `player`, lazy expiry, and 'revoked' surfacing.
 *   * revokeToken — one-way, idempotent 'active' -> 'revoked' transition;
 *     replays return the stored first-write-wins revoked_at.
 *
 * Atomicity strategy (single statements, no D1 batch needed — same pattern
 * as src/sessions/repo.ts and src/payments/repo.ts, which this adapter
 * mirrors without modifying them):
 *   * Every state change is one guarded `INSERT|UPDATE ... RETURNING`;
 *     `first()` yields null when a guard skipped the write, and the UNIQUE
 *     indexes are the cross-row backstop for concurrent attempts (D1 is a
 *     serialized single writer).
 *   * A UNIQUE conflict outside the ON CONFLICT target throws in SQLite;
 *     it is caught, classified by follow-up reads, and re-thrown only when
 *     no stored row explains it (infrastructure errors are never masked as
 *     domain outcomes).
 *
 * Timestamps: ISO-8601 UTC strings (Date.toISOString()), matching the TEXT
 * columns. SQL comparisons are lexicographic, which is exact for this
 * canonical format; TS-side checks parse dates so they also tolerate
 * equivalent spellings. A row is valid strictly until its expires_at: at
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

export type WalletChallengeStatus = 'pending' | 'consumed' | 'expired'
export type AuthTokenStatus = 'active' | 'revoked' | 'expired'

export interface WalletChallengeRecord {
  challengeId: string
  /** Wallet the challenge verifies; the only identity ever bound to it. */
  player: string
  /** SHA-256 hex digest of the challenge payload; never the payload itself. */
  challengeHash: string
  status: WalletChallengeStatus
  /** Payment bound at consumption; at most one challenge per payment. */
  paymentId: string | null
  createdAt: string
  expiresAt: string
  consumedAt: string | null
  updatedAt: string
}

export interface AuthTokenRecord {
  tokenId: string
  /** SHA-256 hex digest of the bearer token; never the token itself. */
  tokenHash: string
  /** Wallet this token authenticates (wallet binding). */
  player: string
  /** Consumed challenge that proved the wallet, when known. */
  challengeId: string | null
  /** Payment this token authorizes, when bound; one token per payment. */
  paymentId: string | null
  status: AuthTokenStatus
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  updatedAt: string
}

export interface IssueChallengeInput {
  /** 0x-prefixed 20-byte wallet (42 chars); enforced by the schema CHECK. */
  player: string
  /** SHA-256 hex digest (64 hex chars) of the challenge payload to sign. */
  challengeHash: string
  /** ISO-8601 UTC instant the challenge stops being consumable; must be
   * after `at` (a challenge that is already expired is a caller bug). */
  expiresAt: string
  /** ISO-8601 clock used for created_at/updated_at stamps; defaults to now. */
  at?: string
}

export interface GetChallengeOptions {
  /** When set, only the owning wallet sees the row; other wallets get null. */
  player?: string
  /** ISO-8601 clock for the lazy expiry transition; defaults to now. */
  at?: string
}

export interface ConsumeChallengeInput {
  /** wallet_challenges.id of the challenge to consume. */
  challengeId: string
  /** Verifying wallet; must equal the challenge's bound player. */
  player: string
  /** Optional payment to bind one-use; the challenge must not already hold
   * a different payment, and no other challenge may hold this one. */
  paymentId?: string
  /** ISO-8601 clock used for expiry comparison and stamps; defaults to now. */
  at?: string
}

export type IssueChallengeResult =
  /** This call inserted the challenge (status 'pending'). */
  | { outcome: 'issued'; record: WalletChallengeRecord }
  /** UNIQUE (challenge_hash): this digest is already issued to the SAME
   * wallet; `record` is the stored first-write-wins truth. */
  | { outcome: 'already_issued'; record: WalletChallengeRecord }
  /** The digest is already issued to ANOTHER wallet. */
  | { outcome: 'identity_conflict'; record: WalletChallengeRecord }

export type ConsumeChallengeResult =
  /** This call atomically performed the one-time consumption. */
  | { outcome: 'accepted'; record: WalletChallengeRecord }
  /** The stored challenge is already consumed; `record` is the
   * first-write-wins truth (original consumed_at / payment binding). */
  | { outcome: 'already_consumed'; record: WalletChallengeRecord }
  /** The challenge exists but is bound to another wallet; `record` is the
   * stored owner's row. Nothing was consumed. */
  | { outcome: 'wrong_player'; record: WalletChallengeRecord }
  /** The challenge is past expires_at (stored 'expired', or 'pending' past
   * expiry at `at`). Nothing was consumed. */
  | { outcome: 'expired'; record: WalletChallengeRecord }
  /** The payment binding disagrees with stored state: the challenge already
   * holds a different payment, or another challenge holds this payment
   * (UNIQUE (payment_id) backstop). Nothing was changed. */
  | { outcome: 'payment_conflict'; record: WalletChallengeRecord }
  /** No challenge with this id. */
  | { outcome: 'not_found'; record: null }

export interface IssueTokenInput {
  /** Wallet the token authenticates; stored as the token's binding. */
  player: string
  /** SHA-256 hex digest (64 hex chars) of the bearer token. */
  tokenHash: string
  /** ISO-8601 UTC instant the token stops resolving as valid; must be
   * after `at`. */
  expiresAt: string
  /** Consumed challenge proving the wallet; at most one token per
   * challenge (UNIQUE (challenge_id)). */
  challengeId?: string
  /** Payment this token authorizes; at most one token per payment
   * (UNIQUE (payment_id)). Must reference an existing payments row (FK). */
  paymentId?: string
  /** ISO-8601 clock used for created_at/updated_at stamps; defaults to now. */
  at?: string
}

export type IssueTokenResult =
  /** This call inserted the token (status 'active'). */
  | { outcome: 'issued'; record: AuthTokenRecord }
  /** A token already exists for this digest/challenge/payment for the SAME
   * wallet; `record` is the stored ORIGINAL token's row, so a retry
   * resolves to the first token instead of minting a second. */
  | { outcome: 'already_issued'; record: AuthTokenRecord }
  /** The digest, challenge, or payment is already bound to ANOTHER wallet's
   * token. `record` is the stored owner's row when one is found. */
  | { outcome: 'identity_conflict'; record: AuthTokenRecord | null }

export interface ResolveTokenOptions {
  /** When set, the token must be bound to this wallet; a mismatch reports
   * 'wrong_player' with the stored owner instead of silently passing. */
  player?: string
  /** ISO-8601 clock for the lazy expiry transition; defaults to now. */
  at?: string
}

export type ResolveTokenResult =
  /** The digest matches a live, unrevoked, unexpired token. */
  | { outcome: 'valid'; record: AuthTokenRecord }
  /** The token was revoked; revoked_at is the stored first-write-wins truth. */
  | { outcome: 'revoked'; record: AuthTokenRecord }
  /** The token is past expires_at (lazily transitioned to 'expired'). */
  | { outcome: 'expired'; record: AuthTokenRecord }
  /** The token exists but is bound to another wallet. */
  | { outcome: 'wrong_player'; record: AuthTokenRecord }
  /** No token with this digest. */
  | { outcome: 'not_found'; record: null }

export type RevokeTokenResult =
  /** This call performed the one-way revocation. */
  | { outcome: 'revoked'; record: AuthTokenRecord }
  /** The token was already revoked; `record` keeps the original revoked_at. */
  | { outcome: 'already_revoked'; record: AuthTokenRecord }
  /** The token is in a terminal 'expired' state; nothing to revoke. */
  | { outcome: 'not_revocable'; record: AuthTokenRecord }
  /** No token with this digest. */
  | { outcome: 'not_found'; record: null }

export interface AuthRepo {
  /** Issue one pending challenge per digest; never a duplicate row. */
  issueChallenge(input: IssueChallengeInput): Promise<IssueChallengeResult>
  /** Read a challenge by opaque id (owner-filtered); lazily expires. */
  getChallenge(challengeId: string, options?: GetChallengeOptions): Promise<WalletChallengeRecord | null>
  /** One-time consumption guarded on owner, status, expiry, and binding. */
  consumeChallenge(input: ConsumeChallengeInput): Promise<ConsumeChallengeResult>
  /** Issue one active token per digest/challenge/payment; idempotent. */
  issueToken(input: IssueTokenInput): Promise<IssueTokenResult>
  /** Bearer verification by digest, with wallet binding and lazy expiry. */
  resolveToken(tokenHash: string, options?: ResolveTokenOptions): Promise<ResolveTokenResult>
  /** Idempotent one-way revocation by digest. */
  revokeToken(input: { tokenHash: string; at?: string }): Promise<RevokeTokenResult>
}

const CHALLENGE_COLUMNS = `
  id AS challengeId, player, challenge_hash AS challengeHash, status,
  payment_id AS paymentId, created_at AS createdAt, expires_at AS expiresAt,
  consumed_at AS consumedAt, updated_at AS updatedAt
`

const TOKEN_COLUMNS = `
  id AS tokenId, token_hash AS tokenHash, player, challenge_id AS challengeId,
  payment_id AS paymentId, status, created_at AS createdAt,
  expires_at AS expiresAt, revoked_at AS revokedAt, updated_at AS updatedAt
`

/** Insert one pending challenge per digest; ON CONFLICT (challenge_hash)
 * DO NOTHING makes replay deterministic instead of throwing. */
const INSERT_CHALLENGE_SQL = `
  INSERT INTO wallet_challenges (
    id, player, challenge_hash, status, created_at, expires_at, updated_at
  )
  VALUES (?, ?, ?, 'pending', ?, ?, ?)
  ON CONFLICT (challenge_hash) DO NOTHING
  RETURNING ${CHALLENGE_COLUMNS}
`

const SELECT_CHALLENGE_BY_ID_SQL = `
  SELECT ${CHALLENGE_COLUMNS} FROM wallet_challenges WHERE id = ?
`

const SELECT_CHALLENGE_BY_HASH_SQL = `
  SELECT ${CHALLENGE_COLUMNS} FROM wallet_challenges WHERE challenge_hash = ?
`

/** Diagnostics for a UNIQUE (payment_id) backstop hit on consumption. */
const SELECT_CHALLENGE_BY_PAYMENT_SQL = `
  SELECT ${CHALLENGE_COLUMNS} FROM wallet_challenges WHERE payment_id = ?
`

/** Lazily transition a passed-expiry pending row; the guard makes the
 * transition idempotent and race-free (only one UPDATE can win). */
const EXPIRE_CHALLENGE_SQL = `
  UPDATE wallet_challenges SET status = 'expired', updated_at = ?
  WHERE id = ? AND status = 'pending' AND expires_at <= ?
  RETURNING ${CHALLENGE_COLUMNS}
`

/** One-time consumption: every guard (owner, status, expiry, and payment
 * binding) lives in this single WHERE clause, so no interleaving can
 * consume a challenge twice or rebind its payment. COALESCE keeps the
 * first binding; the guard refuses to overwrite an existing one. */
const CONSUME_CHALLENGE_SQL = `
  UPDATE wallet_challenges SET
    status = 'consumed',
    consumed_at = ?,
    payment_id = COALESCE(payment_id, ?),
    updated_at = ?
  WHERE id = ?
    AND player = ?
    AND status = 'pending'
    AND expires_at > ?
    AND (payment_id IS NULL OR payment_id = ?)
  RETURNING ${CHALLENGE_COLUMNS}
`

/** Insert one active token per digest; UNIQUE (challenge_id) and
 * UNIQUE (payment_id) are the one-token-per-binding backstops (they throw
 * and are classified, mirroring the payments repo's other-unique path). */
const INSERT_TOKEN_SQL = `
  INSERT INTO auth_tokens (
    id, token_hash, player, challenge_id, payment_id, status,
    created_at, expires_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
  ON CONFLICT (token_hash) DO NOTHING
  RETURNING ${TOKEN_COLUMNS}
`

const SELECT_TOKEN_BY_HASH_SQL = `
  SELECT ${TOKEN_COLUMNS} FROM auth_tokens WHERE token_hash = ?
`

const SELECT_TOKEN_BY_CHALLENGE_SQL = `
  SELECT ${TOKEN_COLUMNS} FROM auth_tokens WHERE challenge_id = ?
`

const SELECT_TOKEN_BY_PAYMENT_SQL = `
  SELECT ${TOKEN_COLUMNS} FROM auth_tokens WHERE payment_id = ?
`

/** Lazily transition a passed-expiry active token; idempotent by guard. */
const EXPIRE_TOKEN_SQL = `
  UPDATE auth_tokens SET status = 'expired', updated_at = ?
  WHERE token_hash = ? AND status = 'active' AND expires_at <= ?
  RETURNING ${TOKEN_COLUMNS}
`

/** One-way revocation, idempotent by guard: only a live 'active' row can
 * transition, so concurrent revokes resolve to one 'revoked' plus replays
 * carrying the original revoked_at. */
const REVOKE_TOKEN_SQL = `
  UPDATE auth_tokens SET status = 'revoked', revoked_at = ?, updated_at = ?
  WHERE token_hash = ? AND status = 'active'
  RETURNING ${TOKEN_COLUMNS}
`

const CHALLENGE_STATUSES: readonly WalletChallengeStatus[] = ['pending', 'consumed', 'expired']
const TOKEN_STATUSES: readonly AuthTokenStatus[] = ['active', 'revoked', 'expired']

function readChallengeStatus(value: unknown): WalletChallengeStatus {
  if (
    typeof value === 'string' &&
    (CHALLENGE_STATUSES as readonly string[]).includes(value)
  ) {
    return value as WalletChallengeStatus
  }
  throw new Error(`auth repo: unexpected wallet_challenges.status in row: ${String(value)}`)
}

function readTokenStatus(value: unknown): AuthTokenStatus {
  if (typeof value === 'string' && (TOKEN_STATUSES as readonly string[]).includes(value)) {
    return value as AuthTokenStatus
  }
  throw new Error(`auth repo: unexpected auth_tokens.status in row: ${String(value)}`)
}

function toChallengeRecord(
  row: Record<string, unknown> | null | undefined,
): WalletChallengeRecord | null {
  if (row == null) return null
  return {
    challengeId: String(row.challengeId),
    player: String(row.player),
    challengeHash: String(row.challengeHash),
    status: readChallengeStatus(row.status),
    paymentId: row.paymentId == null ? null : String(row.paymentId),
    createdAt: String(row.createdAt ?? ''),
    expiresAt: String(row.expiresAt ?? ''),
    consumedAt: row.consumedAt == null ? null : String(row.consumedAt),
    updatedAt: String(row.updatedAt ?? ''),
  }
}

function toTokenRecord(row: Record<string, unknown> | null | undefined): AuthTokenRecord | null {
  if (row == null) return null
  return {
    tokenId: String(row.tokenId),
    tokenHash: String(row.tokenHash),
    player: String(row.player),
    challengeId: row.challengeId == null ? null : String(row.challengeId),
    paymentId: row.paymentId == null ? null : String(row.paymentId),
    status: readTokenStatus(row.status),
    createdAt: String(row.createdAt ?? ''),
    expiresAt: String(row.expiresAt ?? ''),
    revokedAt: row.revokedAt == null ? null : String(row.revokedAt),
    updatedAt: String(row.updatedAt ?? ''),
  }
}

/** SHA-256 digests only: exactly 64 hex chars (case-normalized to lower so
 * lookups and the UNIQUE index agree on the canonical spelling). Anything
 * else — a raw bearer token, a wallet signature, a private key — is a
 * caller bug and is rejected BEFORE any SQL runs. */
function normalizeDigest(kind: string, value: string): string {
  const normalized = value.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new TypeError(
      `auth repo: ${kind} must be a 64-char sha-256 hex digest, got length ${value.length}`,
    )
  }
  return normalized
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
  throw new Error('auth repo: crypto.randomUUID is unavailable')
}

function nowIso(): string {
  return new Date().toISOString()
}

/** True when the error looks like a SQLite UNIQUE-constraint failure on a
 * column this repo treats as a classified binding (payment_id /
 * challenge_id); everything else (FK, CHECK, infrastructure) propagates. */
function isUniqueViolationOn(error: unknown, column: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('UNIQUE constraint failed') && message.includes(`.${column}`)
}

export function createAuthRepo(db: D1DatabaseLike): AuthRepo {
  return {
    async issueChallenge(input: IssueChallengeInput): Promise<IssueChallengeResult> {
      const at = input.at ?? nowIso()
      const challengeHash = normalizeDigest('challengeHash', input.challengeHash)
      if (isExpiredAt(input.expiresAt, at)) {
        throw new RangeError(
          `auth repo: expiresAt (${input.expiresAt}) must be after at (${at})`,
        )
      }
      const inserted = await db
        .prepare(INSERT_CHALLENGE_SQL)
        .bind(newId(), input.player, challengeHash, at, input.expiresAt, at)
        .first()
      if (inserted) {
        const record = toChallengeRecord(inserted)
        if (!record) throw new Error('auth repo: challenge insert returned an unmappable row')
        return { outcome: 'issued', record }
      }
      // Same digest already stored: classify from the stored row.
      const stored = toChallengeRecord(
        await db.prepare(SELECT_CHALLENGE_BY_HASH_SQL).bind(challengeHash).first(),
      )
      if (!stored) throw new Error('auth repo: challenge conflict left no stored row')
      return stored.player === input.player
        ? { outcome: 'already_issued', record: stored }
        : { outcome: 'identity_conflict', record: stored }
    },

    async getChallenge(
      challengeId: string,
      options?: GetChallengeOptions,
    ): Promise<WalletChallengeRecord | null> {
      const at = options?.at ?? nowIso()
      let record = toChallengeRecord(
        await db.prepare(SELECT_CHALLENGE_BY_ID_SQL).bind(challengeId).first(),
      )
      if (!record) return null
      if (options?.player !== undefined && record.player !== options.player) return null
      if (record.status === 'pending' && isExpiredAt(record.expiresAt, at)) {
        // Lost the transition race (another reader/sweep won): re-read.
        const transitioned = toChallengeRecord(
          await db.prepare(EXPIRE_CHALLENGE_SQL).bind(at, challengeId, at).first(),
        )
        record =
          transitioned ??
          toChallengeRecord(await db.prepare(SELECT_CHALLENGE_BY_ID_SQL).bind(challengeId).first()) ??
          record
      }
      return record
    },

    async consumeChallenge(input: ConsumeChallengeInput): Promise<ConsumeChallengeResult> {
      const at = input.at ?? nowIso()
      const paymentId = input.paymentId ?? null
      try {
        const updated = await db
          .prepare(CONSUME_CHALLENGE_SQL)
          .bind(at, paymentId, at, input.challengeId, input.player, at, paymentId)
          .first()
        if (updated) {
          const record = toChallengeRecord(updated)
          if (!record) throw new Error('auth repo: challenge consume returned an unmappable row')
          return { outcome: 'accepted', record }
        }
      } catch (error) {
        // UNIQUE (payment_id): another challenge already holds this payment.
        // Classify from stored rows; re-throw unless a STORED ROW explains
        // the failure, so infrastructure errors are never masked.
        if (isUniqueViolationOn(error, 'payment_id') && paymentId !== null) {
          const holder = toChallengeRecord(
            await db
              .prepare(SELECT_CHALLENGE_BY_PAYMENT_SQL)
              .bind(paymentId)
              .first()
              .catch(() => null),
          )
          if (holder && holder.challengeId !== input.challengeId) {
            return { outcome: 'payment_conflict', record: holder }
          }
        }
        throw error
      }
      return classifyConsume(db, input, at)
    },

    async issueToken(input: IssueTokenInput): Promise<IssueTokenResult> {
      const at = input.at ?? nowIso()
      const tokenHash = normalizeDigest('tokenHash', input.tokenHash)
      if (isExpiredAt(input.expiresAt, at)) {
        throw new RangeError(
          `auth repo: expiresAt (${input.expiresAt}) must be after at (${at})`,
        )
      }
      let inserted: Record<string, unknown> | null
      try {
        inserted = await db
          .prepare(INSERT_TOKEN_SQL)
          .bind(
            newId(),
            tokenHash,
            input.player,
            input.challengeId ?? null,
            input.paymentId ?? null,
            at,
            input.expiresAt,
            at,
          )
          .first()
      } catch (error) {
        // UNIQUE (challenge_id) / UNIQUE (payment_id): the one-token-per-
        // binding backstops outside the ON CONFLICT target. A stored token
        // for the SAME wallet explains the failure (retry semantics: return
        // the ORIGINAL token's row); another wallet's token is an identity
        // conflict; anything unexplained re-throws.
        if (isUniqueViolationOn(error, 'challenge_id') && input.challengeId) {
          const stored = await classifyTokenBy(
            db, SELECT_TOKEN_BY_CHALLENGE_SQL, input.challengeId, input.player,
          ).catch(() => null)
          if (stored) return stored
        }
        if (isUniqueViolationOn(error, 'payment_id') && input.paymentId) {
          const stored = await classifyTokenBy(
            db, SELECT_TOKEN_BY_PAYMENT_SQL, input.paymentId, input.player,
          ).catch(() => null)
          if (stored) return stored
        }
        throw error
      }
      if (inserted) {
        const record = toTokenRecord(inserted)
        if (!record) throw new Error('auth repo: token insert returned an unmappable row')
        return { outcome: 'issued', record }
      }
      // Same digest already stored: classify from the stored row.
      const stored = toTokenRecord(
        await db.prepare(SELECT_TOKEN_BY_HASH_SQL).bind(tokenHash).first(),
      )
      if (!stored) throw new Error('auth repo: token conflict left no stored row')
      return stored.player === input.player
        ? { outcome: 'already_issued', record: stored }
        : { outcome: 'identity_conflict', record: stored }
    },

    async resolveToken(
      tokenHash: string,
      options?: ResolveTokenOptions,
    ): Promise<ResolveTokenResult> {
      const at = options?.at ?? nowIso()
      const digest = normalizeDigest('tokenHash', tokenHash)
      let record = toTokenRecord(
        await db.prepare(SELECT_TOKEN_BY_HASH_SQL).bind(digest).first(),
      )
      if (!record) return { outcome: 'not_found', record: null }
      if (options?.player !== undefined && record.player !== options.player) {
        return { outcome: 'wrong_player', record }
      }
      if (record.status === 'active' && isExpiredAt(record.expiresAt, at)) {
        // Lost the transition race (another reader/sweep won): re-read.
        const transitioned = toTokenRecord(
          await db.prepare(EXPIRE_TOKEN_SQL).bind(at, digest, at).first(),
        )
        record =
          transitioned ??
          toTokenRecord(await db.prepare(SELECT_TOKEN_BY_HASH_SQL).bind(digest).first()) ??
          record
      }
      if (record.status === 'revoked') return { outcome: 'revoked', record }
      if (record.status === 'expired') return { outcome: 'expired', record }
      return { outcome: 'valid', record }
    },

    async revokeToken(input: { tokenHash: string; at?: string }): Promise<RevokeTokenResult> {
      const at = input.at ?? nowIso()
      const digest = normalizeDigest('tokenHash', input.tokenHash)
      const updated = await db
        .prepare(REVOKE_TOKEN_SQL)
        .bind(at, at, digest)
        .first()
      if (updated) {
        const record = toTokenRecord(updated)
        if (!record) throw new Error('auth repo: revoke returned an unmappable row')
        return { outcome: 'revoked', record }
      }
      // Guard skipped: explain from the stored row (read-only).
      const stored = toTokenRecord(
        await db.prepare(SELECT_TOKEN_BY_HASH_SQL).bind(digest).first(),
      )
      if (!stored) return { outcome: 'not_found', record: null }
      if (stored.status === 'revoked') return { outcome: 'already_revoked', record: stored }
      // Only 'expired' remains (an 'active' row would have transitioned).
      return { outcome: 'not_revocable', record: stored }
    },
  }
}

/** Explain a skipped consume from the stored row (read-only, like the
 * sessions repo's classifyConsume). */
async function classifyConsume(
  db: D1DatabaseLike,
  input: ConsumeChallengeInput,
  at: string,
): Promise<Exclude<ConsumeChallengeResult, { outcome: 'accepted' }>> {
  const stored = toChallengeRecord(
    await db.prepare(SELECT_CHALLENGE_BY_ID_SQL).bind(input.challengeId).first(),
  )
  if (!stored) return { outcome: 'not_found', record: null }
  if (stored.player !== input.player) return { outcome: 'wrong_player', record: stored }
  if (stored.status === 'consumed') {
    if (
      input.paymentId !== undefined &&
      stored.paymentId !== null &&
      stored.paymentId !== input.paymentId
    ) {
      return { outcome: 'payment_conflict', record: stored }
    }
    return { outcome: 'already_consumed', record: stored }
  }
  if (stored.status === 'expired') {
    return { outcome: 'expired', record: stored }
  }
  if (isExpiredAt(stored.expiresAt, at)) {
    // Pending past expiry (no prior read transitioned it): lazily persist
    // the same guarded transition getChallenge performs, so the refused
    // consume reports (and stores) the terminal state, not a stale row.
    const transitioned = toChallengeRecord(
      await db.prepare(EXPIRE_CHALLENGE_SQL).bind(at, input.challengeId, at).first(),
    )
    const record =
      transitioned ??
      toChallengeRecord(await db.prepare(SELECT_CHALLENGE_BY_ID_SQL).bind(input.challengeId).first()) ??
      stored
    return { outcome: 'expired', record }
  }
  // Still pending and unexpired: the binding guard must have skipped.
  return { outcome: 'payment_conflict', record: stored }
}

/** Classify a UNIQUE-binding conflict on auth_tokens by the stored token:
 * same wallet -> already_issued (the ORIGINAL token's row), another wallet
 * -> identity_conflict. Returns null when nothing stored explains it. */
async function classifyTokenBy(
  db: D1DatabaseLike,
  sql: string,
  key: string,
  player: string,
): Promise<IssueTokenResult | null> {
  const stored = toTokenRecord(await db.prepare(sql).bind(key).first())
  if (!stored) return null
  return stored.player === player
    ? { outcome: 'already_issued', record: stored }
    : { outcome: 'identity_conflict', record: stored }
}
