/**
 * Type-only contract for a future D1 payment idempotency adapter.
 *
 * Deliberately self-contained: no imports, no runtime logic, no SQL. A later
 * phase implements this interface against Cloudflare D1 (guarded upsert on the
 * unique keys); until then these types are the persistence seam.
 */

/** One idempotent payment-consumption attempt. */
export interface PaymentConsumeInput {
  /** Chain id the payment was observed on (46630 testnet / 4663 mainnet). */
  chainId: number
  /** 0x-prefixed 32-byte transaction hash; unique per chain. */
  txHash: string
  /** 0x-prefixed 20-byte payer address. */
  player: string
  /** Client idempotency key; unique per player. */
  paymentId: string
  /** Decimal wei amount as a string (uint256 does not fit a JS number). */
  amountWei: string
}

/**
 * Outcome of a consume attempt. Exactly one call for a given payment gets
 * `accepted`; every replay of that payment gets `already_consumed`.
 */
export type PaymentConsumeResult =
  /** This call performed the consumption. */
  | { outcome: 'accepted'; consumedAt: string }
  /** A prior call already consumed this payment; `consumedAt` is the original. */
  | { outcome: 'already_consumed'; consumedAt: string }

/** Minimal persistence surface the D1 adapter will implement. */
export interface PaymentRepository {
  /** Idempotently consume a payment; never persists a duplicate consumption. */
  consume(input: PaymentConsumeInput): Promise<PaymentConsumeResult>
}
