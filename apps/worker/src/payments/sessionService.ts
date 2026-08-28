import type {
  ConsumePaymentInput,
  PaymentRecord,
  PaymentsRepo,
} from './repo.ts'
import type {
  CreateSessionInput,
  SessionRecord,
  SessionsRepo,
} from '../sessions/repo.ts'

const SUPPORTED_CHAIN_IDS = new Set([46630, 4663])
const SESSION_STATUSES = new Set(['active', 'completed', 'expired', 'consumed'])

export interface PaymentSessionInput {
  /** 0x-prefixed 32-byte transaction hash supplied by the caller. */
  txHash: string
  /** Client idempotency identity; preserved literally after validation. */
  paymentId: string
  /** Already authenticated wallet identity. */
  player: string
  /** Exact build hash the session must bind to. */
  buildHash: string
  /** Positive safe integer session lifetime in milliseconds. */
  ttlMs: number

}

export interface PaymentVerificationRequest {
  txHash: string
  paymentId: string
  player: string
}

/**
 * Verifies the on-chain payment outside this module and returns the complete,
 * server-derived D1 payment input. Client input is limited to identity fields;
 * amount, chain, block, and confirmation metadata must come from this seam.
 */
export type PaymentVerifier = (
  request: PaymentVerificationRequest,
) => Promise<ConsumePaymentInput>

export interface PaymentSessionDeps {
  verifyPayment: PaymentVerifier
  payments: PaymentsRepo
  sessions: SessionsRepo
  /** Workers-compatible random seed source; defaults to WebCrypto Uint32. */
  seed?: () => number
  /** ISO-8601 clock source; authoritative for expiry and persistence. */
  now?: () => string
}

export type PaymentSessionFailureReason =
  | 'invalid_input'
  | 'invalid_verification'
  | 'payment_identity_conflict'
  | 'payment_not_consumable'
  | 'infrastructure'

export type PaymentSessionFailureStage = 'input' | 'verification' | 'payment' | 'session'

export type PaymentSessionResult =
  | {
      ok: true
      outcome: 'created' | 'already_exists'
      payment: PaymentRecord
      session: SessionRecord
    }
  | {
      ok: false
      reason: PaymentSessionFailureReason
      stage: PaymentSessionFailureStage
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWalletAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(value) &&
    !/^0x0{40}$/i.test(value)
  )
}

function isTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && !Number.isNaN(Date.parse(value))
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value)
}

function invalid(stage: PaymentSessionFailureStage): PaymentSessionResult {
  return { ok: false, reason: 'invalid_input', stage }
}

function infrastructure(stage: PaymentSessionFailureStage): PaymentSessionResult {
  return { ok: false, reason: 'infrastructure', stage }
}

function parseInput(value: unknown, now: () => string):
  | { ok: true; input: PaymentSessionInput; player: string; txHash: string; at: string; expiresAt: string; seed: number }
  | { ok: false } {
  if (!isRecord(value)) return { ok: false }
  const { txHash, paymentId, player, buildHash, ttlMs } = value
  if (!isTransactionHash(txHash) || !isWalletAddress(player)) return { ok: false }
  if (typeof paymentId !== 'string' || paymentId.trim() === '') return { ok: false }
  if (typeof buildHash !== 'string' || !/^[0-9a-f]{64}$/.test(buildHash)) return { ok: false }
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    return { ok: false }
  }
  const normalizedPlayer = player.toLowerCase()
  const normalizedTxHash = txHash.toLowerCase()
  const resolvedAt = now()
  if (!isIsoInstant(resolvedAt)) return { ok: false }
  const atMs = Date.parse(resolvedAt)
  const expiresAtMs = atMs + ttlMs
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= atMs) return { ok: false }
  let expiresAt: string
  try {
    expiresAt = new Date(expiresAtMs).toISOString()
  } catch {
    return { ok: false }
  }

  return {
    ok: true,
    input: {
      txHash,
      paymentId,
      player,
      buildHash,
      ttlMs,
    },
    player: normalizedPlayer,
    txHash: normalizedTxHash,
    at: resolvedAt,
    expiresAt,
    seed: -1,
  }
}

function defaultSeed(): number {
  const source = (globalThis as {
    crypto?: { getRandomValues: (array: Uint32Array) => Uint32Array }
  }).crypto
  if (!source?.getRandomValues) throw new Error('WebCrypto unavailable')
  const values = source.getRandomValues(new Uint32Array(1))
  return values[0] ?? -1
}

function validVerifiedInput(
  value: unknown,
  expected: { player: string; txHash: string; paymentId: string },
): value is ConsumePaymentInput {
  if (!isRecord(value)) return false
  if (!SUPPORTED_CHAIN_IDS.has(value.chainId as number)) return false
  if (!isTransactionHash(value.txHash) || value.txHash.toLowerCase() !== expected.txHash) return false
  if (!isWalletAddress(value.player) || value.player.toLowerCase() !== expected.player) return false
  if (value.paymentId !== expected.paymentId || !isDecimal(value.amountWei)) return false
  const blockNumber = value.blockNumber
  if (
    blockNumber !== undefined &&
    blockNumber !== null &&
    (typeof blockNumber !== 'number' || !Number.isSafeInteger(blockNumber) || blockNumber < 0)
  ) {
    return false
  }
  if (value.confirmedAt !== undefined && !isIsoInstant(value.confirmedAt)) return false
  if (value.at !== undefined && !isIsoInstant(value.at)) return false
  return true
}

function validPaymentRecord(
  value: unknown,
  expected: { player: string; txHash: string; paymentId: string; chainId: number },
): value is PaymentRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.status === 'consumed' &&
    typeof value.player === 'string' &&
    value.player.toLowerCase() === expected.player &&
    typeof value.txHash === 'string' &&
    value.txHash.toLowerCase() === expected.txHash &&
    value.paymentId === expected.paymentId &&
    value.chainId === expected.chainId &&
    isDecimal(value.amountWei)
  )
}

function validSessionRecord(
  value: unknown,
  expected: { paymentId: string; player: string; buildHash: string },
): value is SessionRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    value.paymentId === expected.paymentId &&
    typeof value.player === 'string' &&
    value.player.toLowerCase() === expected.player &&
    typeof value.seed === 'number' &&
    Number.isSafeInteger(value.seed) &&
    value.seed >= 0 &&
    value.buildHash === expected.buildHash &&
    typeof value.status === 'string' &&
    SESSION_STATUSES.has(value.status) &&
    isIsoInstant(value.createdAt) &&
    isIsoInstant(value.expiresAt) &&
    isIsoInstant(value.updatedAt)
  )
}

/**
 * Orchestrate one verified payment into one durable, payment-bound session.
 * This module deliberately has no HTTP surface: authentication and on-chain
 * verification are injected by a later route layer.
 */
export async function createPaymentSession(
  value: unknown,
  deps: PaymentSessionDeps,
): Promise<PaymentSessionResult> {
  let parsed: ReturnType<typeof parseInput>
  try {
    parsed = parseInput(value, deps.now ?? (() => new Date().toISOString()))
  } catch {
    return invalid('input')
  }
  if (!parsed.ok) return invalid('input')

  let seed: number
  try {
    seed = (deps.seed ?? defaultSeed)()
  } catch {
    return invalid('input')
  }
  if (!Number.isSafeInteger(seed) || seed < 0) return invalid('input')

  let verified: unknown
  try {
    verified = await deps.verifyPayment({
      txHash: parsed.txHash,
      paymentId: parsed.input.paymentId,
      player: parsed.player,
    })
  } catch {
    return infrastructure('verification')
  }
  if (
    !validVerifiedInput(verified, {
      player: parsed.player,
      txHash: parsed.txHash,
      paymentId: parsed.input.paymentId,
    })
  ) {
    return { ok: false, reason: 'invalid_verification', stage: 'verification' }
  }

  const paymentInput: ConsumePaymentInput = {
    ...verified,
    txHash: parsed.txHash,
    player: parsed.player,
    paymentId: parsed.input.paymentId,
    at: parsed.at,
  }
  let paymentResult: unknown
  try {
    paymentResult = await deps.payments.consume(paymentInput)
  } catch {
    return infrastructure('payment')
  }
  if (!isRecord(paymentResult) || typeof paymentResult.outcome !== 'string') {
    return infrastructure('payment')
  }
  if (paymentResult.outcome === 'identity_conflict') {
    return { ok: false, reason: 'payment_identity_conflict', stage: 'payment' }
  }
  if (paymentResult.outcome === 'not_consumable') {
    return { ok: false, reason: 'payment_not_consumable', stage: 'payment' }
  }
  if (paymentResult.outcome !== 'accepted' && paymentResult.outcome !== 'already_consumed') {
    return infrastructure('payment')
  }
  const payment = paymentResult.record
  if (
    !validPaymentRecord(payment, {
      player: parsed.player,
      txHash: parsed.txHash,
      paymentId: parsed.input.paymentId,
      chainId: verified.chainId,
    })
  ) {
    return infrastructure('payment')
  }

  const sessionInput: CreateSessionInput = {
    paymentId: payment.id,
    player: parsed.player,
    seed,
    buildHash: parsed.input.buildHash,
    expiresAt: parsed.expiresAt,
    at: parsed.at,
  }
  let sessionResult: unknown
  try {
    sessionResult = await deps.sessions.create(sessionInput)
  } catch {
    return infrastructure('session')
  }
  if (!isRecord(sessionResult) || typeof sessionResult.outcome !== 'string') {
    return infrastructure('session')
  }
  if (sessionResult.outcome === 'payment_not_consumed') {
    return { ok: false, reason: 'payment_not_consumable', stage: 'session' }
  }
  if (sessionResult.outcome !== 'created' && sessionResult.outcome !== 'already_exists') {
    return infrastructure('session')
  }
  if (
    !validSessionRecord(sessionResult.record, {
      paymentId: payment.id,
      player: parsed.player,
      buildHash: parsed.input.buildHash,
    })
  ) {
    return infrastructure('session')
  }

  return {
    ok: true,
    outcome: sessionResult.outcome,
    payment,
    session: sessionResult.record,
  }
}
