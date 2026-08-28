import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ConsumePaymentInput,
  ConsumePaymentResult,
  PaymentRecord,
  PaymentsRepo,
} from '../src/payments/repo.ts'
import type {
  CreateSessionInput,
  CreateSessionResult,
  SessionRecord,
  SessionsRepo,
} from '../src/sessions/repo.ts'
import {
  createPaymentSession,
  type PaymentSessionDeps,
  type PaymentSessionInput,
} from '../src/payments/sessionService.ts'

const PLAYER_MIXED = '0xAa00000000000000000000000000000000000001'
const PLAYER = PLAYER_MIXED.toLowerCase()
const TX_MIXED = '0x' + 'AB'.repeat(32)
const TX = TX_MIXED.toLowerCase()
const CLIENT_PAYMENT_ID = 'client-payment-1'
const PAYMENT_ROW_ID = 'payment-row-1'
const BUILD_HASH = 'a'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const EXPIRES_AT = '2026-01-01T00:01:00.000Z'

const paymentRecord: PaymentRecord = {
  id: PAYMENT_ROW_ID,
  chainId: 46630,
  txHash: TX,
  player: PLAYER,
  paymentId: CLIENT_PAYMENT_ID,
  amountWei: '1000000000000000',
  blockNumber: 42,
  status: 'consumed',
  createdAt: AT,
  updatedAt: AT,
  confirmedAt: AT,
  consumedAt: AT,
}

const sessionRecord: SessionRecord = {
  sessionId: 'session-1',
  paymentId: PAYMENT_ROW_ID,
  player: PLAYER,
  seed: 123,
  buildHash: BUILD_HASH,
  status: 'active',
  createdAt: AT,
  expiresAt: EXPIRES_AT,
  consumedAt: null,
  updatedAt: AT,
}

function validInput(overrides: Partial<PaymentSessionInput> = {}): PaymentSessionInput {
  return {
    txHash: TX_MIXED,
    paymentId: CLIENT_PAYMENT_ID,
    player: PLAYER_MIXED,
    buildHash: BUILD_HASH,
    ttlMs: 60_000,
    ...overrides,
  }
}

function validVerifiedInput(overrides: Partial<ConsumePaymentInput> = {}): ConsumePaymentInput {
  return {
    chainId: 46630,
    txHash: TX,
    player: PLAYER,
    paymentId: CLIENT_PAYMENT_ID,
    amountWei: paymentRecord.amountWei,
    blockNumber: paymentRecord.blockNumber,
    confirmedAt: AT,
    at: AT,
    ...overrides,
  }
}

function makeDeps(options: {
  paymentOutcome?: ConsumePaymentResult
  sessionOutcome?: CreateSessionResult
  verify?: PaymentSessionDeps['verifyPayment']
  seed?: () => number
  onPayment?: (input: ConsumePaymentInput) => void
  onSession?: (input: CreateSessionInput) => void
} = {}): PaymentSessionDeps & { paymentCalls: ConsumePaymentInput[]; sessionCalls: CreateSessionInput[]; verifyCalls: string[] } {
  const paymentCalls: ConsumePaymentInput[] = []
  const sessionCalls: CreateSessionInput[] = []
  const verifyCalls: string[] = []
  const paymentOutcome = options.paymentOutcome ?? { outcome: 'accepted', record: paymentRecord }
  const sessionOutcome = options.sessionOutcome ?? { outcome: 'created', record: sessionRecord }

  return {
    verifyPayment:
      options.verify ??
      (async (request) => {
        verifyCalls.push(request.player)
        return validVerifiedInput({
          txHash: request.txHash,
          player: request.player,
          paymentId: request.paymentId,
        })
      }),
    payments: {
      async consume(input) {
        paymentCalls.push(input)
        options.onPayment?.(input)
        return paymentOutcome
      },
      async getByTxHash() {
        return null
      },
    } satisfies PaymentsRepo,
    sessions: {
      async create(input) {
        sessionCalls.push(input)
        options.onSession?.(input)
        return sessionOutcome
      },
      async get() {
        return null
      },
      async consume() {
        return { outcome: 'not_found', record: null }
      },
    } satisfies SessionsRepo,
    seed: options.seed ?? (() => 123),
    now: () => AT,
    paymentCalls,
    sessionCalls,
    verifyCalls,
  }
}

function assertInfrastructure(result: Awaited<ReturnType<typeof createPaymentSession>>, stage: string): void {
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'infrastructure')
  assert.equal(result.stage, stage)
}

test('accepted payment creates a session using the durable payments.id foreign key', async () => {
  const deps = makeDeps()
  const result = await createPaymentSession(validInput(), deps)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.outcome, 'created')
  assert.equal(result.payment.id, PAYMENT_ROW_ID)
  assert.equal(result.session.paymentId, PAYMENT_ROW_ID)
  assert.equal(deps.verifyCalls.length, 1)
  assert.equal(deps.paymentCalls.length, 1)
  assert.equal(deps.sessionCalls.length, 1)
  assert.equal(deps.sessionCalls[0]?.paymentId, PAYMENT_ROW_ID)
  assert.notEqual(deps.sessionCalls[0]?.paymentId, CLIENT_PAYMENT_ID)
  assert.equal(deps.sessionCalls[0]?.player, PLAYER)
  assert.equal(deps.sessionCalls[0]?.seed, 123)
  assert.equal(deps.sessionCalls[0]?.expiresAt, EXPIRES_AT)
})

test('already-consumed payment can recover by creating its missing payment-bound session', async () => {
  const deps = makeDeps({ paymentOutcome: { outcome: 'already_consumed', record: paymentRecord } })
  const result = await createPaymentSession(validInput(), deps)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.outcome, 'created')
  assert.equal(result.payment.status, 'consumed')
  assert.equal(deps.paymentCalls.length, 1)
  assert.equal(deps.sessionCalls.length, 1)
})

test('session already_exists is returned as an idempotent success', async () => {
  const stored = { ...sessionRecord, seed: 999 }
  const deps = makeDeps({
    sessionOutcome: { outcome: 'already_exists', record: stored },
    seed: () => 123,
  })
  const result = await createPaymentSession(validInput(), deps)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.outcome, 'already_exists')
  assert.equal(result.session.seed, 999)
  assert.equal(deps.sessionCalls.length, 1)
})

test('payment identity conflict fails closed without creating a session', async () => {
  const deps = makeDeps({
    paymentOutcome: { outcome: 'identity_conflict', record: paymentRecord },
  })
  const result = await createPaymentSession(validInput(), deps)

  assert.deepEqual(result, {
    ok: false,
    reason: 'payment_identity_conflict',
    stage: 'payment',
  })
  assert.equal(deps.sessionCalls.length, 0)
})

test('non-consumable payment fails closed without creating a session', async () => {
  const rejected = { ...paymentRecord, status: 'rejected' as const }
  const deps = makeDeps({ paymentOutcome: { outcome: 'not_consumable', record: rejected } })
  const result = await createPaymentSession(validInput(), deps)

  assert.deepEqual(result, { ok: false, reason: 'payment_not_consumable', stage: 'payment' })
  assert.equal(deps.sessionCalls.length, 0)
})

test('invalid request is rejected before verifier or repository calls', async () => {
  for (const input of [
    validInput({ player: '0x0000000000000000000000000000000000000000' }),
    validInput({ txHash: '0x1234' }),
    validInput({ paymentId: '   ' }),
    validInput({ buildHash: 'A'.repeat(64) }),
    validInput({ ttlMs: 0 }),
  ]) {
    const deps = makeDeps()
    const result = await createPaymentSession(input, deps)
    assert.deepEqual(result, { ok: false, reason: 'invalid_input', stage: 'input' })
    assert.equal(deps.verifyCalls.length, 0)
    assert.equal(deps.paymentCalls.length, 0)
    assert.equal(deps.sessionCalls.length, 0)
  }
})

test('malformed verifier output is rejected before payment persistence', async () => {
  const deps = makeDeps({
    verify: async () => validVerifiedInput({ amountWei: 'not-decimal' }),
  })
  const result = await createPaymentSession(validInput(), deps)

  assert.deepEqual(result, { ok: false, reason: 'invalid_verification', stage: 'verification' })
  assert.equal(deps.paymentCalls.length, 0)
  assert.equal(deps.sessionCalls.length, 0)
})

test('verifier identity mismatch fails closed before payment persistence', async () => {
  const deps = makeDeps({
    verify: async () => validVerifiedInput({ paymentId: 'different-payment' }),
  })
  const result = await createPaymentSession(validInput(), deps)

  assert.deepEqual(result, { ok: false, reason: 'invalid_verification', stage: 'verification' })
  assert.equal(deps.paymentCalls.length, 0)
})

test('verifier exception is generic infrastructure failure', async () => {
  const deps = makeDeps({ verify: async () => { throw new Error('do not expose this') } })
  const result = await createPaymentSession(validInput(), deps)
  assertInfrastructure(result, 'verification')
})

test('payment repository exception is generic infrastructure failure', async () => {
  const deps = makeDeps()
  deps.payments = {
    async consume() {
      throw new Error('SQL detail must not escape')
    },
    async getByTxHash() {
      return null
    },
  }
  const result = await createPaymentSession(validInput(), deps)
  assertInfrastructure(result, 'payment')
  assert.equal(deps.sessionCalls.length, 0)
})

test('session repository exception is generic infrastructure failure', async () => {
  const deps = makeDeps()
  deps.sessions = {
    async create() {
      throw new Error('SQL detail must not escape')
    },
    async get() {
      return null
    },
    async consume() {
      return { outcome: 'not_found', record: null }
    },
  }
  const result = await createPaymentSession(validInput(), deps)
  assertInfrastructure(result, 'session')
})

test('invalid seed fails before verifier and payment persistence', async () => {
  const deps = makeDeps({ seed: () => -1 })
  const result = await createPaymentSession(validInput(), deps)

  assert.deepEqual(result, { ok: false, reason: 'invalid_input', stage: 'input' })
  assert.equal(deps.verifyCalls.length, 0)
  assert.equal(deps.paymentCalls.length, 0)
})

test('mismatched payment or session records fail closed', async () => {
  const badPayment = makeDeps({ paymentOutcome: { outcome: 'accepted', record: { ...paymentRecord, player: '0xBb00000000000000000000000000000000000002' } } })
  const paymentResult = await createPaymentSession(validInput(), badPayment)
  assertInfrastructure(paymentResult, 'payment')

  const badSession = makeDeps({ sessionOutcome: { outcome: 'created', record: { ...sessionRecord, buildHash: 'b'.repeat(64) } } })
  const sessionResult = await createPaymentSession(validInput(), badSession)
  assertInfrastructure(sessionResult, 'session')
})

test('supported chain and exact expiry are passed to the durable repositories', async () => {
  const deps = makeDeps()
  await createPaymentSession(validInput({ ttlMs: 1 }), deps)
  assert.equal(deps.paymentCalls[0]?.chainId, 46630)
  assert.equal(deps.sessionCalls[0]?.expiresAt, '2026-01-01T00:00:00.001Z')
  assert.ok((deps.sessionCalls[0]?.expiresAt ?? '') > AT)
})

test('uses the injected clock when the request omits at', async () => {
  const deps = makeDeps()
  deps.now = () => AT
  const result = await createPaymentSession(validInput(), deps)

  assert.equal(result.ok, true)
  assert.equal(deps.paymentCalls[0]?.at, AT)
  assert.equal(deps.sessionCalls[0]?.at, AT)
  assert.equal(deps.sessionCalls[0]?.expiresAt, EXPIRES_AT)
})

test('does not trust a caller timestamp to extend session expiry', async () => {
  const deps = makeDeps()
  const result = await createPaymentSession(
    { ...validInput(), at: '2099-01-01T00:00:00.000Z' },
    deps,
  )

  assert.equal(result.ok, true)
  assert.equal(deps.paymentCalls[0]?.at, AT)
  assert.equal(deps.sessionCalls[0]?.at, AT)
  assert.equal(deps.sessionCalls[0]?.expiresAt, EXPIRES_AT)
})
