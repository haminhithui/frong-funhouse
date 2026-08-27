/**
 * Worker-side D1 repository adapter — PAYMENT IDEMPOTENCY ONLY.
 *
 * Scope: persist and atomically reject duplicate payment consumption using the
 * existing `payments` schema from `migrations/0001_init.sql`. Not wired to any
 * HTTP route yet (see src/index.ts — unchanged); later phases inject this repo.
 *
 * Atomicity strategy (single statement, no D1 batch needed):
 *   Consumption is one `INSERT ... ON CONFLICT (chain_id, tx_hash) DO UPDATE
 *   ... WHERE <guard> RETURNING ...` upsert. SQLite's UNIQUE indexes —
 *   `(chain_id, tx_hash)` and `(player, payment_id)` — are the atomic
 *   backstop: exactly one call can insert the row, and D1 serializes writes
 *   (single writer), so concurrent attempts resolve deterministically to
 *   one `accepted` plus `already_consumed` for every replay.
 *
 * D1 API notes / limitations this design works around:
 *   * D1 rejects explicit `BEGIN`/`COMMIT` via prepare(); `batch()` is the only
 *     transaction primitive. A guarded upsert keeps the whole state change in
 *     ONE statement, so no batch is required.
 *   * `meta.changes` typing varies across workers-types versions, so the
 *     insert/transition outcome is read from `RETURNING` + `first()` instead
 *     (`first()` yields null when the conflict guard skipped the write).
 *   * A conflict on the *other* unique key (`player, payment_id`) is not
 *     handled by the ON CONFLICT target and throws; it is caught, classified
 *     by follow-up reads, and re-thrown only when no stored row explains it.
 */

/** Minimal structural slice of D1 used here. The real `D1Database` /
 * `D1PreparedStatement` from @cloudflare/workers-types are assignable to these,
 * and unit tests inject an in-memory fake. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: unknown }>
  run<T = Record<string, unknown>>(): Promise<{ results?: T[]; meta?: unknown }>
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike
}

export type PaymentStatus = 'observed' | 'confirmed' | 'consumed' | 'rejected'

export interface PaymentRecord {
  id: string
  chainId: number
  txHash: string
  player: string
  paymentId: string
  amountWei: string
  blockNumber: number | null
  status: PaymentStatus
  createdAt: string
  updatedAt: string
  confirmedAt: string | null
  consumedAt: string | null
}

export interface ConsumePaymentInput {
  /** 46630 (testnet) or 4663 (mainnet); enforced by the schema CHECK. */
  chainId: number
  /** 0x-prefixed 32-byte transaction hash (66 chars). */
  txHash: string
  /** 0x-prefixed 20-byte payer address (42 chars). */
  player: string
  /** Client idempotency key; unique per player. */
  paymentId: string
  /** Decimal wei amount as a string (uint256 does not fit a JS number). */
  amountWei: string
  blockNumber?: number | null
  /** When the payment was confirmed on chain; defaults to `at`. */
  confirmedAt?: string
  /** ISO-8601 clock used for created/updated/consumed stamps; defaults to now. */
  at?: string
}

export type ConsumePaymentResult =
  /** This call atomically performed the consumption (insert, or transition of
   *  an `observed`/`confirmed` row that matches the same identity). */
  | { outcome: 'accepted'; record: PaymentRecord }
  /** A stored row is already consumed; `record` is the stored first-write-wins
   *  truth, so replays (even with a later `at`) return identical records. */
  | { outcome: 'already_consumed'; record: PaymentRecord }
  /** The unique keys are owned by different identities: the tx exists under
   *  another player/paymentId, or the (player, paymentId) belongs to another
   *  tx. `record` is the stored owner (by tx or by payment identity). */
  | { outcome: 'identity_conflict'; record: PaymentRecord | null }
  /** Same tx and identity, but the stored status is not consumable
   *  (e.g. 'rejected'). */
  | { outcome: 'not_consumable'; record: PaymentRecord }

export interface PaymentsRepo {
  /** Idempotently consume a payment. Never inserts a duplicate row. */
  consume(input: ConsumePaymentInput): Promise<ConsumePaymentResult>
  /** Read the stored payment for a chain + tx, or null. */
  getByTxHash(chainId: number, txHash: string): Promise<PaymentRecord | null>
}

const UPSERT_SQL = `
  INSERT INTO payments (
    id, chain_id, tx_hash, player, payment_id, amount_wei, block_number,
    status, confirmed_at, consumed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'consumed', ?, ?, ?, ?)
  ON CONFLICT (chain_id, tx_hash) DO UPDATE SET
    status       = 'consumed',
    consumed_at  = COALESCE(payments.consumed_at, excluded.consumed_at),
    confirmed_at = COALESCE(payments.confirmed_at, excluded.confirmed_at),
    amount_wei   = COALESCE(NULLIF(excluded.amount_wei, ''), payments.amount_wei),
    block_number = COALESCE(excluded.block_number, payments.block_number),
    updated_at   = excluded.updated_at
  WHERE payments.status IN ('observed', 'confirmed')
    AND payments.player = excluded.player
    AND payments.payment_id = excluded.payment_id
  RETURNING id, chain_id AS chainId, tx_hash AS txHash, player, payment_id AS paymentId,
    amount_wei AS amountWei, block_number AS blockNumber, status,
    created_at AS createdAt, updated_at AS updatedAt,
    confirmed_at AS confirmedAt, consumed_at AS consumedAt
`

const SELECT_BY_TX_SQL = `
  SELECT id, chain_id AS chainId, tx_hash AS txHash, player, payment_id AS paymentId,
    amount_wei AS amountWei, block_number AS blockNumber, status,
    created_at AS createdAt, updated_at AS updatedAt,
    confirmed_at AS confirmedAt, consumed_at AS consumedAt
  FROM payments WHERE chain_id = ? AND tx_hash = ?
`

const SELECT_BY_IDENTITY_SQL = `
  SELECT id, chain_id AS chainId, tx_hash AS txHash, player, payment_id AS paymentId,
    amount_wei AS amountWei, block_number AS blockNumber, status,
    created_at AS createdAt, updated_at AS updatedAt,
    confirmed_at AS confirmedAt, consumed_at AS consumedAt
  FROM payments WHERE player = ? AND payment_id = ?
`

const STATUSES: readonly PaymentStatus[] = ['observed', 'confirmed', 'consumed', 'rejected']

function readStatus(value: unknown): PaymentStatus {
  if (typeof value === 'string' && (STATUSES as readonly string[]).includes(value)) {
    return value as PaymentStatus
  }
  throw new Error(`payments repo: unexpected status in row: ${String(value)}`)
}

function toRecord(row: Record<string, unknown> | null | undefined): PaymentRecord | null {
  if (row == null) return null
  return {
    id: String(row.id),
    chainId: Number(row.chainId),
    txHash: String(row.txHash),
    player: String(row.player),
    paymentId: String(row.paymentId),
    amountWei: String(row.amountWei ?? ''),
    blockNumber: row.blockNumber == null ? null : Number(row.blockNumber),
    status: readStatus(row.status),
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
    confirmedAt: row.confirmedAt == null ? null : String(row.confirmedAt),
    consumedAt: row.consumedAt == null ? null : String(row.consumedAt),
  }
}

/** crypto.randomUUID without depending on ambient Workers/DOM typings. */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  throw new Error('payments repo: crypto.randomUUID is unavailable')
}

function nowIso(): string {
  return new Date().toISOString()
}

export function createPaymentsRepo(db: D1DatabaseLike): PaymentsRepo {
  async function classify(
    input: ConsumePaymentInput,
  ): Promise<Exclude<ConsumePaymentResult, { outcome: 'accepted' }>> {
    const byTx = toRecord(
      await db.prepare(SELECT_BY_TX_SQL).bind(input.chainId, input.txHash).first(),
    )
    if (byTx) {
      // Identity is checked BEFORE status: a stored tx replayed under a
      // different (player, payment_id) belongs to another payment, so it must
      // surface as identity_conflict even when that row is already consumed.
      if (byTx.player !== input.player || byTx.paymentId !== input.paymentId) {
        return { outcome: 'identity_conflict', record: byTx }
      }
      if (byTx.status === 'consumed') return { outcome: 'already_consumed', record: byTx }
      return { outcome: 'not_consumable', record: byTx }
    }
    // No row for this tx: a UNIQUE(player, payment_id) hit explains the skip.
    // record stays null when nothing in storage explains the failure.
    const byIdentity = toRecord(
      await db.prepare(SELECT_BY_IDENTITY_SQL).bind(input.player, input.paymentId).first(),
    )
    return { outcome: 'identity_conflict', record: byIdentity }
  }

  return {
    async consume(input: ConsumePaymentInput): Promise<ConsumePaymentResult> {
      const at = input.at ?? nowIso()
      const params: unknown[] = [
        newId(),
        input.chainId,
        input.txHash,
        input.player,
        input.paymentId,
        input.amountWei,
        input.blockNumber ?? null,
        input.confirmedAt ?? at,
        at,
        at,
        at,
      ]
      let inserted: Record<string, unknown> | null
      try {
        inserted = await db.prepare(UPSERT_SQL).bind(...params).first()
      } catch (error) {
        // The (player, payment_id) unique is outside the ON CONFLICT target.
        // Classify from stored rows; re-throw unless a STORED ROW explains the
        // failure, so infrastructure errors (and caller CHECK violations with
        // no matching rows) are never masked as domain outcomes.
        const explained = await classify(input).catch(() => null)
        if (explained?.outcome === 'identity_conflict' && explained.record) return explained
        throw error
      }
      if (inserted) {
        const record = toRecord(inserted)
        if (!record) throw new Error('payments repo: upsert returned an unmappable row')
        // Defensive: the guard matched identity, but verify before claiming.
        if (record.player === input.player && record.paymentId === input.paymentId) {
          return { outcome: 'accepted', record }
        }
        return { outcome: 'identity_conflict', record }
      }
      return classify(input)
    },

    async getByTxHash(chainId: number, txHash: string): Promise<PaymentRecord | null> {
      return toRecord(await db.prepare(SELECT_BY_TX_SQL).bind(chainId, txHash).first())
    },
  }
}
