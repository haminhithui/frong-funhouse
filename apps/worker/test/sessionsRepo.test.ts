/**
 * Focused tests for the Worker-side D1 game-session repository
 * (src/sessions/repo.ts). Runs on Node's built-in test runner:
 *
 *   node --test apps/worker/test/sessionsRepo.test.ts
 *
 * The D1 API is faked with node:sqlite over the REAL migration SQL, so every
 * constraint (UNIQUE (payment_id), FK to payments, CHECK enums, guarded
 * UPDATE ... RETURNING) behaves as in D1's SQLite engine.
 * Limitation: node:sqlite is synchronous, so "concurrent" attempts are
 * interleaved promises rather than parallel connections; on real D1,
 * serialized single-writer semantics + the single-statement guards provide
 * the same guarantee the stress test observes here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import {
  createSessionsRepo,
  type CreateSessionInput,
  type D1DatabaseLike,
  type D1StatementLike,
  type SessionRecord,
} from '../src/sessions/repo.ts'

const migrationSql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')

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

/** Seed a payments row (the sessions FK target); defaults to a consumed
 * payment owned by PLAYER. */
function seedPayment(
  db: FakeD1,
  opts: { id?: string; player?: string; status?: string; txHash?: string } = {},
) {
  db.raw(
    `INSERT INTO payments (id, chain_id, tx_hash, player, payment_id, amount_wei, status)
     VALUES (?, 46630, ?, ?, ?, '10000000000000000', ?)`,
    opts.id ?? 'pay-1',
    opts.txHash ?? tx('11'),
    opts.player ?? PLAYER,
    `client-${opts.id ?? 'pay-1'}`,
    opts.status ?? 'consumed',
  )
}

function createInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    paymentId: 'pay-1',
    player: PLAYER,
    seed: 123456789,
    buildHash: 'build-abc123',
    expiresAt: '2026-01-01T00:10:00.000Z',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const rowToRecord = (r: Record<string, unknown>): SessionRecord => ({
  sessionId: String(r.session_id),
  paymentId: String(r.payment_id),
  player: String(r.player),
  seed: Number(r.seed),
  buildHash: String(r.build_hash),
  status: String(r.status) as SessionRecord['status'],
  createdAt: String(r.created_at),
  expiresAt: String(r.expires_at),
  consumedAt: r.consumed_at == null ? null : String(r.consumed_at),
  updatedAt: String(r.updated_at),
})

const consumeInput = (sessionId: string, overrides: { player?: string; at?: string } = {}) => ({
  sessionId,
  player: overrides.player ?? PLAYER,
  at: overrides.at ?? '2026-01-01T00:05:00.000Z',
})

async function seedActiveSession(db: FakeD1, overrides: Partial<CreateSessionInput> = {}) {
  const r = createSessionsRepo(db)
  const res = await r.create(createInput(overrides))
  assert.equal(res.outcome, 'created')
  return { repo: r, created: res.record }
}

test('create persists one active session bound to the consumed payment; get reads it back', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const r = createSessionsRepo(db)
  const res = await r.create(createInput())
  assert.equal(res.outcome, 'created')
  assert.equal(res.record.status, 'active')
  assert.equal(res.record.paymentId, 'pay-1')
  assert.equal(res.record.player, PLAYER)
  assert.equal(res.record.seed, 123456789)
  assert.equal(res.record.buildHash, 'build-abc123')
  assert.equal(res.record.expiresAt, '2026-01-01T00:10:00.000Z')
  assert.equal(res.record.consumedAt, null)
  assert.ok(res.record.sessionId.length > 0)
  assert.equal(db.raw('SELECT COUNT(*) c FROM sessions')[0].c, 1)
  // persisted row matches the returned record field-for-field
  const stored = rowToRecord(db.raw('SELECT * FROM sessions')[0])
  for (const k of Object.keys(res.record) as (keyof SessionRecord)[]) {
    assert.equal(res.record[k], stored[k], `field ${String(k)}`)
  }
  // read back by id, plainly and owner-filtered (clock pinned to the
  // create instant; an unpinned get would run against the real wall clock
  // and correctly lazy-expire this 2026-01-01 fixture)
  assert.deepEqual(
    await r.get(res.record.sessionId, { at: '2026-01-01T00:00:00.000Z' }),
    res.record,
  )
  assert.deepEqual(
    await r.get(res.record.sessionId, { player: PLAYER, at: '2026-01-01T00:05:00.000Z' }),
    res.record,
  )
  assert.equal(await r.get(res.record.sessionId, { player: PLAYER2 }), null)
  assert.equal(await r.get('no-such-session'), null)
})

test('create is one-per-payment: replay returns already_exists with the stored record', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const r = createSessionsRepo(db)
  const first = await r.create(createInput())
  assert.equal(first.outcome, 'created')
  // replay (even with a later clock) is first-write-wins, no second row
  const replay = await r.create(createInput({ at: '2026-01-01T00:01:00.000Z' }))
  assert.equal(replay.outcome, 'already_exists')
  assert.deepEqual(replay.record, first.record)
  assert.equal(db.raw('SELECT COUNT(*) c FROM sessions')[0].c, 1)
  // another wallet cannot claim the same payment: the payment is not theirs
  const other = await r.create(createInput({ player: PLAYER2 }))
  assert.equal(other.outcome, 'payment_not_consumed')
  assert.equal(other.paymentPlayer, PLAYER)
  assert.equal(db.raw('SELECT COUNT(*) c FROM sessions')[0].c, 1)
})

test('create rejects payments that are missing, unconsumed, or owned by another wallet', async () => {
  // no payments row at all
  const db0 = new FakeD1()
  const r0 = createSessionsRepo(db0)
  const missing = await r0.create(createInput())
  assert.equal(missing.outcome, 'payment_not_consumed')
  assert.equal(missing.paymentStatus, null)
  assert.equal(missing.paymentPlayer, null)
  assert.equal(db0.raw('SELECT COUNT(*) c FROM sessions')[0].c, 0)

  // payment exists but is not 'consumed'
  const db1 = new FakeD1()
  seedPayment(db1, { status: 'confirmed' })
  const unconsumed = await createSessionsRepo(db1).create(createInput())
  assert.equal(unconsumed.outcome, 'payment_not_consumed')
  assert.equal(unconsumed.paymentStatus, 'confirmed')
  assert.equal(unconsumed.paymentPlayer, PLAYER)
  assert.equal(db1.raw('SELECT COUNT(*) c FROM sessions')[0].c, 0)

  // payment is consumed but belongs to another wallet
  const db2 = new FakeD1()
  seedPayment(db2, { player: PLAYER2 })
  const foreign = await createSessionsRepo(db2).create(createInput())
  assert.equal(foreign.outcome, 'payment_not_consumed')
  assert.equal(foreign.paymentStatus, 'consumed')
  assert.equal(foreign.paymentPlayer, PLAYER2)
  assert.equal(db2.raw('SELECT COUNT(*) c FROM sessions')[0].c, 0)
})

test('create caller bugs (bad seed, already-expired) throw and persist nothing', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const r = createSessionsRepo(db)
  await assert.rejects(r.create(createInput({ seed: -1 })), TypeError)
  await assert.rejects(r.create(createInput({ seed: 1.5 })), TypeError)
  await assert.rejects(r.create(createInput({ expiresAt: '2025-12-31T23:59:59.999Z' })), RangeError)
  // expiry boundary: expires_at == at is already expired
  await assert.rejects(r.create(createInput({ expiresAt: '2026-01-01T00:00:00.000Z' })), RangeError)
  assert.equal(db.raw('SELECT COUNT(*) c FROM sessions')[0].c, 0)
})

test('schema CHECK violations propagate as errors (caller bug, not an outcome)', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const r = createSessionsRepo(db)
  // empty build_hash reaches the INSERT (payment qualifies) and trips the CHECK
  await assert.rejects(r.create(createInput({ buildHash: '' })))
  assert.equal(db.raw('SELECT COUNT(*) c FROM sessions')[0].c, 0)
})

test('expired session: get lazily transitions to expired and consume refuses', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, created } = await seedActiveSession(db)
  // still valid one millisecond before expiry
  const before = await repo.get(created.sessionId, { at: '2026-01-01T00:09:59.999Z' })
  assert.equal(before?.status, 'active')
  // at exactly expires_at the session is expired (valid strictly until then)
  const at = '2026-01-01T00:10:00.000Z'
  const got = await repo.get(created.sessionId, { at })
  assert.equal(got?.status, 'expired')
  assert.equal(got?.consumedAt, null)
  // the transition is persisted, once (re-read returns the same row)
  assert.equal(db.raw('SELECT status FROM sessions')[0].status, 'expired')
  assert.deepEqual(await repo.get(created.sessionId, { at: '2026-01-01T00:11:00.000Z' }), got)
  // consume after expiry is refused and stores nothing
  const res = await repo.consume(consumeInput(created.sessionId, { at }))
  assert.equal(res.outcome, 'expired')
  assert.equal(res.record.status, 'expired')
  assert.equal(db.raw('SELECT consumed_at FROM sessions')[0].consumed_at, null)
})

test('an active-but-past-expiry session (no prior read) is refused as expired on consume', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, created } = await seedActiveSession(db)
  // no get() happened: the row still says 'active' in storage
  assert.equal(db.raw('SELECT status FROM sessions')[0].status, 'active')
  const res = await repo.consume(
    consumeInput(created.sessionId, { at: '2026-01-01T00:20:00.000Z' }),
  )
  assert.equal(res.outcome, 'expired')
  assert.equal(db.raw('SELECT consumed_at FROM sessions')[0].consumed_at, null)
})

test('wrong player: consume is refused with the stored owner, and the owner can still consume', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, created } = await seedActiveSession(db)
  const res = await repo.consume(consumeInput(created.sessionId, { player: PLAYER2 }))
  assert.equal(res.outcome, 'wrong_player')
  assert.equal(res.record.player, PLAYER)
  assert.equal(res.record.status, 'active') // untouched by the refusal
  assert.equal(db.raw('SELECT status FROM sessions')[0].status, 'active')
  // the owner consumes afterwards: accepted
  const owner = await repo.consume(consumeInput(created.sessionId))
  assert.equal(owner.outcome, 'accepted')
  assert.equal(owner.record.consumedAt, '2026-01-01T00:05:00.000Z')
})

test('replay after consume returns already_consumed with first-write-wins stamps', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, created } = await seedActiveSession(db)
  const first = await repo.consume(consumeInput(created.sessionId))
  assert.equal(first.outcome, 'accepted')
  assert.equal(first.record.status, 'consumed')
  // replay with a LATER clock: the original consumed_at wins
  const replay = await repo.consume(
    consumeInput(created.sessionId, { at: '2026-01-01T00:08:00.000Z' }),
  )
  assert.equal(replay.outcome, 'already_consumed')
  assert.deepEqual(replay.record, first.record)
  assert.equal(replay.record.consumedAt, '2026-01-01T00:05:00.000Z')
  assert.equal(
    db.raw('SELECT consumed_at, status FROM sessions')[0].consumed_at,
    first.record.consumedAt,
  )
  // reads after consumption keep reporting the consumed record (no lazy expire)
  const got = await repo.get(created.sessionId, { at: '2026-01-01T01:00:00.000Z' })
  assert.equal(got?.status, 'consumed')
  assert.equal(got?.consumedAt, first.record.consumedAt)
})

test('25 interleaved consumes: exactly one accepted, rest already_consumed', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, created } = await seedActiveSession(db)
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      repo.consume(
        consumeInput(created.sessionId, {
          at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }),
      ),
    ),
  )
  const accepted = results.filter((x) => x.outcome === 'accepted')
  const consumed = results.filter((x) => x.outcome === 'already_consumed')
  assert.equal(accepted.length, 1)
  assert.equal(consumed.length, 24)
  for (const c of consumed) assert.deepEqual(c.record, accepted[0].record)
  // exactly one row, consumed exactly once, by the single accepted call
  const rows = db.raw('SELECT * FROM sessions')
  assert.equal(rows.length, 1)
  assert.equal(rowToRecord(rows[0]).consumedAt, accepted[0].record.consumedAt)
})

test('consuming an unknown session is not_found', async () => {
  const db = new FakeD1()
  const r = createSessionsRepo(db)
  const res = await r.consume(consumeInput('no-such-session'))
  assert.equal(res.outcome, 'not_found')
  assert.equal(res.record, null)
})

test('a completed session is terminal: not_consumable', async () => {
  const db = new FakeD1()
  seedPayment(db)
  const { repo, created } = await seedActiveSession(db)
  db.raw(`UPDATE sessions SET status = 'completed' WHERE session_id = ?`, created.sessionId)
  const res = await repo.consume(consumeInput(created.sessionId))
  assert.equal(res.outcome, 'not_consumable')
  assert.equal(res.record.status, 'completed')
  assert.equal(db.raw('SELECT consumed_at FROM sessions')[0].consumed_at, null)
})

test('two players hold independent sessions from distinct payments', async () => {
  const db = new FakeD1()
  seedPayment(db, { id: 'pay-1', txHash: tx('11') })
  seedPayment(db, { id: 'pay-2', player: PLAYER2, txHash: tx('22') })
  const r = createSessionsRepo(db)
  const a = await r.create(createInput())
  const b = await r.create(createInput({ paymentId: 'pay-2', player: PLAYER2 }))
  assert.equal(a.outcome, 'created')
  assert.equal(b.outcome, 'created')
  assert.equal(db.raw('SELECT COUNT(*) c FROM sessions')[0].c, 2)
  assert.equal(await r.get(b.record.sessionId, { player: PLAYER }), null)
  assert.equal((await r.get(b.record.sessionId, { player: PLAYER2 }))?.player, PLAYER2)
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
  const r = createSessionsRepo(explodingDb)
  await assert.rejects(r.create(createInput()), (e: unknown) => e === failure)
  await assert.rejects(r.get('any'), (e: unknown) => e === failure)
  await assert.rejects(r.consume(consumeInput('any')), (e: unknown) => e === failure)
})
