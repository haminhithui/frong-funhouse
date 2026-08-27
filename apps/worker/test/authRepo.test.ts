/**
 * Focused tests for the Worker-side D1 auth repository
 * (src/auth/repo.ts) over migration 0002 (wallet_challenges,
 * auth_tokens). Runs on Node's built-in test runner:
 *
 *   node --test apps/worker/test/authRepo.test.ts
 *
 * The D1 API is faked with node:sqlite over the REAL migration SQL (0001
 * then 0002, in order, exactly like D1 applies them), so every constraint
 * (UNIQUE digests, UNIQUE (challenge_id) / UNIQUE (payment_id), CHECK
 * enums and digest lengths, FKs, guarded UPDATE ... RETURNING) behaves as
 * in D1's SQLite engine.
 * Limitation: node:sqlite is synchronous, so "concurrent" attempts are
 * interleaved promises rather than parallel connections; on real D1,
 * serialized single-writer semantics + the single-statement guards provide
 * the same guarantee the stress tests observe here.
 *
 * Areas (mirroring the task brief): expiry, wrong wallet, replay, token
 * hash lookup, revocation, duplicate challenge/payment bindings, malformed
 * state — plus the no-raw-credential boundary and infrastructure-failure
 * propagation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import {
  createAuthRepo,
  type AuthTokenRecord,
  type ConsumeChallengeInput,
  type D1DatabaseLike,
  type D1StatementLike,
  type IssueTokenInput,
  type WalletChallengeRecord,
} from '../src/auth/repo.ts'

/** Apply every migration in filename order, like `wrangler d1 migrations
 * apply` does — 0001 (payments FK target) before 0002. */
const migrationsDir = new URL('../migrations/', import.meta.url)
const migrationSql = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(new URL(name, migrationsDir), 'utf8'))
  .join('\n')

class FakeStatement implements D1StatementLike {
  #stmt: StatementSync
  #values: SQLInputValue[]
  constructor(stmt: StatementSync, values: SQLInputValue[]) {
    this.#stmt = stmt
    this.#values = values
  }
  bind(...values: unknown[]): D1StatementLike {
    return new FakeStatement(this.#stmt, values as SQLInputValue[])
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.#stmt.get(...this.#values) as T) ?? null
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.#stmt.all(...this.#values) as T[] }
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const r = this.#stmt.run(...this.#values)
    return { meta: { changes: Number(r.changes) } }
  }
}

class FakeD1 implements D1DatabaseLike {
  #db: DatabaseSync
  constructor() {
    this.#db = new DatabaseSync(':memory:')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec(migrationSql)
  }
  prepare(query: string): D1StatementLike {
    return new FakeStatement(this.#db.prepare(query), [])
  }
  /** Test hook: seed / inspect rows directly. */
  raw(sql: string, ...params: SQLInputValue[]): Record<string, unknown>[] {
    return this.#db.prepare(sql).all(...params) as Record<string, unknown>[]
  }
}

const PLAYER = '0x' + 'aa'.repeat(20)
const PLAYER2 = '0x' + 'bb'.repeat(20)
const tx = (byte: string) => '0x' + byte.repeat(32)

/** Distinct sha-256-shaped digests (content only matters for uniqueness). */
const digest = (fill: string) => fill.repeat(64 / fill.length).slice(0, 64)
const HASH_A = digest('a') // challenge digest for PLAYER
const HASH_B = digest('b') // second challenge digest
const TOKEN_A = digest('01')
const TOKEN_B = digest('02')
const TOKEN_C = digest('03')

/** Seed a payments row (FK target for challenge/token payment bindings). */
function seedPayment(db: FakeD1, id = 'pay-1', player = PLAYER, txHash = tx('11')) {
  db.raw(
    `INSERT INTO payments (id, chain_id, tx_hash, player, payment_id, amount_wei, status)
     VALUES (?, 46630, ?, ?, ?, '10000000000000000', 'consumed')`,
    id,
    txHash,
    player,
    `client-${id}`,
  )
}

const challengeInput = (overrides: Partial<Parameters<ReturnType<typeof createAuthRepo>['issueChallenge']>[0]> = {}) => ({
  player: PLAYER,
  challengeHash: HASH_A,
  expiresAt: '2026-01-01T00:10:00.000Z',
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const consumeInput = (
  challengeId: string,
  overrides: Partial<ConsumeChallengeInput> = {},
): ConsumeChallengeInput => ({
  challengeId,
  player: overrides.player ?? PLAYER,
  paymentId: overrides.paymentId,
  at: overrides.at ?? '2026-01-01T00:05:00.000Z',
})

const tokenInput = (overrides: Partial<IssueTokenInput> = {}): IssueTokenInput => ({
  player: PLAYER,
  tokenHash: TOKEN_A,
  expiresAt: '2026-01-01T01:00:00.000Z',
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const rowToChallenge = (r: Record<string, unknown>): WalletChallengeRecord => ({
  challengeId: String(r.id),
  player: String(r.player),
  challengeHash: String(r.challenge_hash),
  status: String(r.status) as WalletChallengeRecord['status'],
  paymentId: r.payment_id == null ? null : String(r.payment_id),
  createdAt: String(r.created_at),
  expiresAt: String(r.expires_at),
  consumedAt: r.consumed_at == null ? null : String(r.consumed_at),
  updatedAt: String(r.updated_at),
})

const rowToToken = (r: Record<string, unknown>): AuthTokenRecord => ({
  tokenId: String(r.id),
  tokenHash: String(r.token_hash),
  player: String(r.player),
  challengeId: r.challenge_id == null ? null : String(r.challenge_id),
  paymentId: r.payment_id == null ? null : String(r.payment_id),
  status: String(r.status) as AuthTokenRecord['status'],
  createdAt: String(r.created_at),
  expiresAt: String(r.expires_at),
  revokedAt: r.revoked_at == null ? null : String(r.revoked_at),
  updatedAt: String(r.updated_at),
})

async function seedChallenge(db: FakeD1, overrides: Parameters<typeof challengeInput>[0] = {}) {
  const repo = createAuthRepo(db)
  const res = await repo.issueChallenge(challengeInput(overrides))
  assert.equal(res.outcome, 'issued')
  return { repo, challenge: res.record }
}

// ---------------------------------------------------------------- challenges --

test('issueChallenge persists one pending challenge bound to the wallet; only the digest is stored', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  assert.equal(challenge.status, 'pending')
  assert.equal(challenge.player, PLAYER)
  assert.equal(challenge.challengeHash, HASH_A)
  assert.equal(challenge.consumedAt, null)
  assert.equal(challenge.paymentId, null)
  assert.ok(challenge.challengeId.length > 0)
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 1)
  // persisted row matches the returned record field-for-field
  const stored = rowToChallenge(db.raw('SELECT * FROM wallet_challenges')[0])
  for (const k of Object.keys(challenge) as (keyof WalletChallengeRecord)[]) {
    assert.equal(challenge[k], stored[k], `field ${String(k)}`)
  }
  // the stored schema has no column capable of holding a raw challenge
  // payload or signature: id/player/challenge_hash/status/payment_id/times
  assert.deepEqual(
    db.raw('PRAGMA table_info(wallet_challenges)').map((c) => String(c.name)).sort(),
    [
      'challenge_hash', 'consumed_at', 'created_at', 'expires_at', 'id',
      'payment_id', 'player', 'status', 'updated_at',
    ],
  )
  // read back: plain, owner-filtered, wrong wallet -> null, unknown -> null
  assert.deepEqual(await repo.getChallenge(challenge.challengeId, { at: '2026-01-01T00:01:00.000Z' }), challenge)
  assert.deepEqual(
    await repo.getChallenge(challenge.challengeId, { player: PLAYER, at: '2026-01-01T00:05:00.000Z' }),
    challenge,
  )
  assert.equal(await repo.getChallenge(challenge.challengeId, { player: PLAYER2 }), null)
  assert.equal(await repo.getChallenge('no-such-challenge'), null)
})

test('issueChallenge is one-per-digest: replay returns already_issued; another wallet is identity_conflict', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  const replay = await repo.issueChallenge(challengeInput({ at: '2026-01-01T00:02:00.000Z' }))
  assert.equal(replay.outcome, 'already_issued')
  assert.deepEqual(replay.record, challenge)
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 1)
  // the same digest under another wallet must not be re-issued
  const foreign = await repo.issueChallenge(challengeInput({ player: PLAYER2 }))
  assert.equal(foreign.outcome, 'identity_conflict')
  assert.equal(foreign.record.player, PLAYER)
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 1)
  // a distinct digest for another wallet is a fresh, independent row
  const other = await repo.issueChallenge(challengeInput({ player: PLAYER2, challengeHash: HASH_B }))
  assert.equal(other.outcome, 'issued')
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 2)
})

test('issueChallenge rejects raw credentials and caller bugs before any SQL runs', async () => {
  const db = new FakeD1()
  const repo = createAuthRepo(db)
  // a raw challenge nonce / signature is NOT a 64-hex sha-256 digest
  await assert.rejects(
    repo.issueChallenge(challengeInput({ challengeHash: 'privy-challenge-nonce-123' })),
    TypeError,
  )
  await assert.rejects(repo.issueChallenge(challengeInput({ challengeHash: digest('a').slice(0, 63) })), TypeError)
  await assert.rejects(repo.issueChallenge(challengeInput({ challengeHash: 'z'.repeat(64) })), TypeError)
  // already-expired expiry is a caller bug (boundary: == at is expired)
  await assert.rejects(
    repo.issueChallenge(challengeInput({ expiresAt: '2025-12-31T23:59:59.999Z' })),
    RangeError,
  )
  await assert.rejects(
    repo.issueChallenge(challengeInput({ expiresAt: '2026-01-01T00:00:00.000Z' })),
    RangeError,
  )
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 0)
})

test('challenge expiry: get lazily transitions to expired at/past the boundary; consume refuses', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  // still pending one millisecond before expiry
  assert.equal((await repo.getChallenge(challenge.challengeId, { at: '2026-01-01T00:09:59.999Z' }))?.status, 'pending')
  // at exactly expires_at the challenge is expired (valid strictly until then)
  const at = '2026-01-01T00:10:00.000Z'
  const got = await repo.getChallenge(challenge.challengeId, { at })
  assert.equal(got?.status, 'expired')
  assert.equal(got?.consumedAt, null)
  // the transition is persisted exactly once; re-reads agree
  assert.equal(db.raw('SELECT status FROM wallet_challenges')[0].status, 'expired')
  assert.deepEqual(await repo.getChallenge(challenge.challengeId, { at: '2026-01-01T00:11:00.000Z' }), got)
  // consuming an expired challenge is refused and stores nothing
  const res = await repo.consumeChallenge(consumeInput(challenge.challengeId, { at }))
  assert.equal(res.outcome, 'expired')
  assert.equal(db.raw('SELECT consumed_at FROM wallet_challenges')[0].consumed_at, null)
})

test('a pending-but-past-expiry challenge (no prior read) is refused as expired on consume', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  assert.equal(db.raw('SELECT status FROM wallet_challenges')[0].status, 'pending')
  const res = await repo.consumeChallenge(consumeInput(challenge.challengeId, { at: '2026-01-01T00:20:00.000Z' }))
  assert.equal(res.outcome, 'expired')
  assert.equal(res.record.status, 'expired')
  assert.equal(db.raw('SELECT consumed_at FROM wallet_challenges')[0].consumed_at, null)
})

test('consume is one-time: accepted once, replay returns already_consumed with first-write-wins stamps', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  const first = await repo.consumeChallenge(consumeInput(challenge.challengeId))
  assert.equal(first.outcome, 'accepted')
  assert.equal(first.record.status, 'consumed')
  assert.equal(first.record.consumedAt, '2026-01-01T00:05:00.000Z')
  // replay with a LATER clock: the original consumed_at wins
  const replay = await repo.consumeChallenge(
    consumeInput(challenge.challengeId, { at: '2026-01-01T00:08:00.000Z' }),
  )
  assert.equal(replay.outcome, 'already_consumed')
  assert.deepEqual(replay.record, first.record)
  // reads after consumption keep reporting the consumed record (no lazy expire)
  const got = await repo.getChallenge(challenge.challengeId, { at: '2026-01-01T01:00:00.000Z' })
  assert.equal(got?.status, 'consumed')
  assert.equal(got?.consumedAt, first.record.consumedAt)
})

test('25 interleaved consumes: exactly one accepted, rest already_consumed', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      repo.consumeChallenge(
        consumeInput(challenge.challengeId, { at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
      ),
    ),
  )
  const accepted = results.filter((x) => x.outcome === 'accepted')
  const replayed = results.filter((x) => x.outcome === 'already_consumed')
  assert.equal(accepted.length, 1)
  assert.equal(replayed.length, 24)
  for (const r of replayed) assert.deepEqual(r.record, accepted[0].record)
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 1)
})

test('wrong wallet: consume is refused with the stored owner, and the owner can still consume', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  const res = await repo.consumeChallenge(consumeInput(challenge.challengeId, { player: PLAYER2 }))
  assert.equal(res.outcome, 'wrong_player')
  assert.equal(res.record.player, PLAYER)
  assert.equal(res.record.status, 'pending') // untouched by the refusal
  assert.equal(db.raw('SELECT status, consumed_at FROM wallet_challenges')[0].status, 'pending')
  // the owner consumes afterwards: accepted
  const owner = await repo.consumeChallenge(consumeInput(challenge.challengeId))
  assert.equal(owner.outcome, 'accepted')
  assert.equal(owner.record.consumedAt, '2026-01-01T00:05:00.000Z')
})

test('consuming an unknown challenge is not_found', async () => {
  const db = new FakeD1()
  const repo = createAuthRepo(db)
  const res = await repo.consumeChallenge(consumeInput('no-such-challenge'))
  assert.equal(res.outcome, 'not_found')
  assert.equal(res.record, null)
})

// ------------------------------------------------- challenge/payment bindings --

test('consume binds the payment one-use; replays with the same payment are idempotent', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, challenge } = await seedChallenge(db)
  const first = await repo.consumeChallenge(consumeInput(challenge.challengeId, { paymentId: 'pay-1' }))
  assert.equal(first.outcome, 'accepted')
  assert.equal(first.record.paymentId, 'pay-1')
  assert.equal(db.raw('SELECT payment_id FROM wallet_challenges')[0].payment_id, 'pay-1')
  // replay with the SAME payment: already_consumed, binding unchanged
  const replay = await repo.consumeChallenge(consumeInput(challenge.challengeId, { paymentId: 'pay-1' }))
  assert.equal(replay.outcome, 'already_consumed')
  assert.deepEqual(replay.record, first.record)
})

test('duplicate payment bindings: another challenge cannot claim the same payment (UNIQUE backstop)', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const repo = createAuthRepo(db)
  const a = await repo.issueChallenge(challengeInput({ challengeHash: HASH_A }))
  const b = await repo.issueChallenge(challengeInput({ challengeHash: HASH_B }))
  assert.equal(a.outcome, 'issued')
  assert.equal(b.outcome, 'issued')
  // challenge A binds pay-1 first
  const first = await repo.consumeChallenge(consumeInput(a.record.challengeId, { paymentId: 'pay-1' }))
  assert.equal(first.outcome, 'accepted')
  // challenge B attempting the same payment: payment_conflict, A unchanged
  const conflict = await repo.consumeChallenge(consumeInput(b.record.challengeId, { paymentId: 'pay-1' }))
  assert.equal(conflict.outcome, 'payment_conflict')
  assert.equal(conflict.record.challengeId, a.record.challengeId)
  assert.equal(conflict.record.paymentId, 'pay-1')
  // B stays pending and unbound; only one row holds the payment
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges WHERE payment_id = ?', 'pay-1')[0].c, 1)
  const bStored = db.raw('SELECT * FROM wallet_challenges WHERE challenge_hash = ?', HASH_B)[0]
  assert.equal(String(bStored.status), 'pending')
  assert.equal(bStored.payment_id, null)
})

test('a bound challenge refuses a DIFFERENT payment, and an unbound replay cannot rebind', async () => {
  const db = new FakeD1()
  seedPayment(db, 'pay-1')
  seedPayment(db, 'pay-2', PLAYER, tx('22'))
  const { repo, challenge } = await seedChallenge(db)
  const first = await repo.consumeChallenge(consumeInput(challenge.challengeId, { paymentId: 'pay-1' }))
  assert.equal(first.outcome, 'accepted')
  // replay binding a different payment: conflict, original binding kept
  const res = await repo.consumeChallenge(consumeInput(challenge.challengeId, { paymentId: 'pay-2' }))
  assert.equal(res.outcome, 'payment_conflict')
  assert.equal(res.record.paymentId, 'pay-1')
  assert.equal(db.raw('SELECT payment_id FROM wallet_challenges')[0].payment_id, 'pay-1')
})

test('binding a payment that does not exist trips the FK and propagates (caller bug)', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  await assert.rejects(
    repo.consumeChallenge(consumeInput(challenge.challengeId, { paymentId: 'ghost-payment' })),
  )
  assert.equal(db.raw('SELECT status FROM wallet_challenges')[0].status, 'pending')
})

// -------------------------------------------------------------------- tokens --

test('issueToken persists one active token bound to the wallet and challenge/payment', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, challenge } = await seedChallenge(db)
  const consumed = await repo.consumeChallenge(consumeInput(challenge.challengeId, { paymentId: 'pay-1' }))
  assert.equal(consumed.outcome, 'accepted')
  const res = await repo.issueToken(
    tokenInput({ challengeId: challenge.challengeId, paymentId: 'pay-1' }),
  )
  assert.equal(res.outcome, 'issued')
  assert.equal(res.record.status, 'active')
  assert.equal(res.record.player, PLAYER)
  assert.equal(res.record.tokenHash, TOKEN_A)
  assert.equal(res.record.challengeId, challenge.challengeId)
  assert.equal(res.record.paymentId, 'pay-1')
  assert.equal(res.record.revokedAt, null)
  assert.equal(db.raw('SELECT COUNT(*) c FROM auth_tokens')[0].c, 1)
  // the stored schema has no column capable of holding a raw bearer token
  assert.deepEqual(
    db.raw('PRAGMA table_info(auth_tokens)').map((c) => String(c.name)).sort(),
    [
      'challenge_id', 'created_at', 'expires_at', 'id', 'payment_id',
      'player', 'revoked_at', 'status', 'token_hash', 'updated_at',
    ],
  )
})

test('issueToken is one-per-digest: replay returns already_issued; another wallet is identity_conflict', async () => {
  const db = new FakeD1()
  const { repo } = { repo: createAuthRepo(db) }
  const first = await repo.issueToken(tokenInput())
  assert.equal(first.outcome, 'issued')
  const replay = await repo.issueToken(tokenInput({ at: '2026-01-01T00:01:00.000Z' }))
  assert.equal(replay.outcome, 'already_issued')
  assert.deepEqual(replay.record, first.record)
  assert.equal(db.raw('SELECT COUNT(*) c FROM auth_tokens')[0].c, 1)
  const foreign = await repo.issueToken(tokenInput({ player: PLAYER2 }))
  assert.equal(foreign.outcome, 'identity_conflict')
  assert.ok(foreign.record) // token identity_conflict carries the owner's row when found
  assert.equal(foreign.record.player, PLAYER)
  assert.equal(db.raw('SELECT COUNT(*) c FROM auth_tokens')[0].c, 1)
})

test('duplicate challenge/payment bindings on tokens resolve to the ORIGINAL token row (retry semantics)', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, challenge } = await seedChallenge(db)
  await repo.consumeChallenge(consumeInput(challenge.challengeId, { paymentId: 'pay-1' }))
  const first = await repo.issueToken(
    tokenInput({ challengeId: challenge.challengeId, paymentId: 'pay-1' }),
  )
  assert.equal(first.outcome, 'issued')
  // a RETRY that generated a fresh digest for the same challenge: the
  // original token's row is returned, not a second token
  const byChallenge = await repo.issueToken(
    tokenInput({ tokenHash: TOKEN_B, challengeId: challenge.challengeId, paymentId: 'pay-1' }),
  )
  assert.equal(byChallenge.outcome, 'already_issued')
  assert.deepEqual(byChallenge.record, first.record)
  // and by payment alone (no challenge linkage on the retry)
  const byPayment = await repo.issueToken(tokenInput({ tokenHash: TOKEN_C, paymentId: 'pay-1' }))
  assert.equal(byPayment.outcome, 'already_issued')
  assert.deepEqual(byPayment.record, first.record)
  assert.equal(db.raw('SELECT COUNT(*) c FROM auth_tokens')[0].c, 1)
  // another wallet cannot bind the same challenge/payment
  const foreign = await repo.issueToken(
    tokenInput({ tokenHash: TOKEN_C, player: PLAYER2, challengeId: challenge.challengeId }),
  )
  assert.equal(foreign.outcome, 'identity_conflict')
  assert.ok(foreign.record) // token identity_conflict carries the owner's row when found
  assert.equal(foreign.record.player, PLAYER)
  assert.equal(db.raw('SELECT COUNT(*) c FROM auth_tokens')[0].c, 1)
})

test('issueToken rejects raw bearer tokens and caller bugs before any SQL runs', async () => {
  const db = new FakeD1()
  const repo = createAuthRepo(db)
  // a raw bearer token is NOT a 64-hex sha-256 digest — never persisted
  await assert.rejects(repo.issueToken(tokenInput({ tokenHash: 'Bearer privy_9f8e7d6c' })), TypeError)
  await assert.rejects(repo.issueToken(tokenInput({ tokenHash: TOKEN_A.toUpperCase() + 'x' })), TypeError)
  await assert.rejects(repo.issueToken(tokenInput({ tokenHash: '' })), TypeError)
  await assert.rejects(
    repo.issueToken(tokenInput({ expiresAt: '2025-12-31T23:59:59.999Z' })),
    RangeError,
  )
  // FK guards: binding a payment/challenge that does not exist propagates
  await assert.rejects(repo.issueToken(tokenInput({ paymentId: 'ghost' })))
  await assert.rejects(repo.issueToken(tokenInput({ challengeId: 'ghost' })))
  assert.equal(db.raw('SELECT COUNT(*) c FROM auth_tokens')[0].c, 0)
})

test('token hash lookup: resolveToken finds the row by digest only (case-normalized)', async () => {
  const db = new FakeD1()
  const { repo } = { repo: createAuthRepo(db) }
  const issued = await repo.issueToken(tokenInput())
  assert.equal(issued.outcome, 'issued')
  const got = await repo.resolveToken(TOKEN_A, { at: '2026-01-01T00:30:00.000Z' })
  assert.equal(got.outcome, 'valid')
  assert.deepEqual(got.record, issued.record)
  // an upper-case spelling of the same digest resolves to the same row
  const upper = await repo.resolveToken(TOKEN_A.toUpperCase(), { at: '2026-01-01T00:30:00.000Z' })
  assert.equal(upper.outcome, 'valid')
  assert.deepEqual(upper.record, issued.record)
  // unknown digest: not_found; malformed digest: TypeError before SQL
  assert.equal((await repo.resolveToken(TOKEN_B)).outcome, 'not_found')
  await assert.rejects(repo.resolveToken('Bearer privy_9f8e7d6c'), TypeError)
  // wallet binding: the token authenticates exactly one wallet (explicit
  // clock keeps these inside the validity window; `at` defaults to the real
  // wall clock, which is past the fixed 2026-01-01 expiry instants)
  assert.equal((await repo.resolveToken(TOKEN_A, { player: PLAYER2, at: '2026-01-01T00:30:00.000Z' })).outcome, 'wrong_player')
  assert.equal((await repo.resolveToken(TOKEN_A, { player: PLAYER, at: '2026-01-01T00:30:00.000Z' })).outcome, 'valid')
})

test('token expiry: resolve lazily transitions to expired at the boundary; revocation still visible', async () => {
  const db = new FakeD1()
  const { repo } = { repo: createAuthRepo(db) }
  const issued = await repo.issueToken(tokenInput()) // expires 2026-01-01T01:00:00.000Z
  assert.equal(issued.outcome, 'issued')
  assert.equal((await repo.resolveToken(TOKEN_A, { at: '2026-01-01T00:59:59.999Z' })).outcome, 'valid')
  const at = '2026-01-01T01:00:00.000Z'
  const got = await repo.resolveToken(TOKEN_A, { at })
  assert.equal(got.outcome, 'expired')
  assert.equal(got.record.status, 'expired')
  assert.equal(got.record.revokedAt, null)
  // the transition is persisted exactly once
  assert.equal(db.raw('SELECT status FROM auth_tokens')[0].status, 'expired')
  assert.deepEqual(await repo.resolveToken(TOKEN_A, { at: '2026-01-01T02:00:00.000Z' }), got)
  // an expired token is terminal for revocation too
  const revoke = await repo.revokeToken({ tokenHash: TOKEN_A, at })
  assert.equal(revoke.outcome, 'not_revocable')
  assert.equal(revoke.record.status, 'expired')
})

test('revocation is one-way and idempotent: first-write-wins revoked_at', async () => {
  const db = new FakeD1()
  const { repo } = { repo: createAuthRepo(db) }
  await repo.issueToken(tokenInput())
  const first = await repo.revokeToken({ tokenHash: TOKEN_A, at: '2026-01-01T00:20:00.000Z' })
  assert.equal(first.outcome, 'revoked')
  assert.equal(first.record.status, 'revoked')
  assert.equal(first.record.revokedAt, '2026-01-01T00:20:00.000Z')
  // replay with a LATER clock: the original revoked_at wins
  const replay = await repo.revokeToken({ tokenHash: TOKEN_A, at: '2026-01-01T00:40:00.000Z' })
  assert.equal(replay.outcome, 'already_revoked')
  assert.deepEqual(replay.record, first.record)
  assert.equal(db.raw('SELECT revoked_at, status FROM auth_tokens')[0].revoked_at, first.record.revokedAt)
  // a revoked token never resolves as valid, even before its expiry
  const resolved = await repo.resolveToken(TOKEN_A, { at: '2026-01-01T00:21:00.000Z' })
  assert.equal(resolved.outcome, 'revoked')
  assert.equal(resolved.record.revokedAt, first.record.revokedAt)
  // revoking an unknown digest is not_found; malformed digest is a TypeError
  assert.equal((await repo.revokeToken({ tokenHash: TOKEN_B })).outcome, 'not_found')
  await assert.rejects(repo.revokeToken({ tokenHash: 'raw-token' }), TypeError)
})

test('25 interleaved revocations: exactly one revoked, rest already_revoked', async () => {
  const db = new FakeD1()
  const { repo } = { repo: createAuthRepo(db) }
  await repo.issueToken(tokenInput())
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      repo.revokeToken({ tokenHash: TOKEN_A, at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
    ),
  )
  assert.equal(results.filter((x) => x.outcome === 'revoked').length, 1)
  assert.equal(results.filter((x) => x.outcome === 'already_revoked').length, 24)
  const rows = db.raw('SELECT * FROM auth_tokens')
  assert.equal(rows.length, 1)
  assert.equal(rowToToken(rows[0]).status, 'revoked')
})

// ----------------------------------------------------------- malformed state --

test('malformed state: rows with unexpected statuses are rejected loudly, never guessed', async () => {
  const db = new FakeD1()
  const { repo, challenge } = await seedChallenge(db)
  await repo.issueToken(tokenInput())
  // simulate corruption: a status outside the CHECK enum lands in a row
  db.raw(`UPDATE wallet_challenges SET status = 'bogus' WHERE id = ?`, challenge.challengeId)
  db.raw(`UPDATE auth_tokens SET status = 'bogus' WHERE token_hash = ?`, TOKEN_A)
  await assert.rejects(repo.getChallenge(challenge.challengeId), /unexpected wallet_challenges\.status/)
  await assert.rejects(repo.consumeChallenge(consumeInput(challenge.challengeId)), /unexpected wallet_challenges\.status/)
  await assert.rejects(repo.resolveToken(TOKEN_A), /unexpected auth_tokens\.status/)
  await assert.rejects(repo.revokeToken({ tokenHash: TOKEN_A }), /unexpected auth_tokens\.status/)
})

test('infrastructure failures propagate and are never classified as outcomes', async () => {
  const failure = new Error('D1 unavailable')
  const explodingDb: D1DatabaseLike = {
    prepare() {
      const boom: D1StatementLike = {
        bind: () => boom,
        first: () => Promise.reject(failure),
        all: () => Promise.reject(failure),
        run: () => Promise.reject(failure),
      }
      return boom
    },
  }
  const repo = createAuthRepo(explodingDb)
  await assert.rejects(repo.issueChallenge(challengeInput()), (e: unknown) => e === failure)
  await assert.rejects(repo.getChallenge('any'), (e: unknown) => e === failure)
  await assert.rejects(repo.consumeChallenge(consumeInput('any')), (e: unknown) => e === failure)
  await assert.rejects(repo.issueToken(tokenInput()), (e: unknown) => e === failure)
  await assert.rejects(repo.resolveToken(TOKEN_A), (e: unknown) => e === failure)
  await assert.rejects(repo.revokeToken({ tokenHash: TOKEN_A }), (e: unknown) => e === failure)
})

/** Test helper: the stored row id for a challenge digest. */
function findId(db: FakeD1, hash: string): string {
  const rows = db.raw('SELECT id FROM wallet_challenges WHERE challenge_hash = ?', hash)
  assert.equal(rows.length, 1)
  return String(rows[0].id)
}
