/**
 * Focused tests for the Worker-side D1 payment idempotency repository
 * (src/payments/repo.ts). Runs on Node's built-in test runner:
 *
 *   node --test apps/worker/test/paymentsRepo.test.ts
 *
 * The D1 API is faked with node:sqlite over the REAL migration SQL, so every
 * constraint (UNIQUE (chain_id, tx_hash), UNIQUE (player, payment_id), CHECK
 * enums, upsert guard, RETURNING) behaves as in D1's SQLite engine.
 * Limitation: node:sqlite is synchronous, so "concurrent" attempts are
 * interleaved promises rather than parallel connections; on real D1,
 * serialized single-writer semantics + the UNIQUE indexes provide the same
 * guarantee the stress test observes here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import {
  createPaymentsRepo,
  type D1DatabaseLike,
  type D1StatementLike,
  type PaymentRecord,
} from '../src/payments/repo.ts'

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

function input(overrides: Partial<Parameters<PaymentsRepoConsume>[0]> = {}) {
  return {
    chainId: 46630,
    txHash: tx('11'),
    player: PLAYER,
    paymentId: 'pay-1',
    amountWei: '10000000000000000',
    blockNumber: 5,
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
type PaymentsRepoConsume = ReturnType<typeof createPaymentsRepo>['consume']

const repo = () => createPaymentsRepo(new FakeD1())
const rowToRecord = (r: Record<string, unknown>): PaymentRecord => ({
  id: String(r.id),
  chainId: Number(r.chain_id),
  txHash: String(r.tx_hash),
  player: String(r.player),
  paymentId: String(r.payment_id),
  amountWei: String(r.amount_wei),
  blockNumber: r.block_number == null ? null : Number(r.block_number),
  status: String(r.status) as PaymentRecord['status'],
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  confirmedAt: r.confirmed_at == null ? null : String(r.confirmed_at),
  consumedAt: r.consumed_at == null ? null : String(r.consumed_at),
})

test('first consume is accepted and persists exactly one row', async () => {
  const db = new FakeD1()
  const r = createPaymentsRepo(db)
  const res = await r.consume(input())
  assert.equal(res.outcome, 'accepted')
  assert.equal(res.record.status, 'consumed')
  assert.equal(res.record.consumedAt, '2026-01-01T00:00:00.000Z')
  const rows = db.raw('SELECT * FROM payments') as Record<string, unknown>[]
  assert.equal(rows.length, 1)
  // persisted row matches the accepted record field-for-field
  const stored = rowToRecord(rows[0])
  for (const k of Object.keys(res.record) as (keyof PaymentRecord)[]) {
    assert.equal(res.record[k], stored[k], `field ${String(k)}`)
  }
})

test('replay with identical input returns already_consumed, no duplicate row', async () => {
  const db = new FakeD1()
  const r = createPaymentsRepo(db)
  const first = await r.consume(input())
  assert.equal(first.outcome, 'accepted')
  const replay = await r.consume(input())
  assert.equal(replay.outcome, 'already_consumed')
  assert.deepEqual(replay.record, first.record)
  assert.equal(db.raw('SELECT COUNT(*) c FROM payments')[0].c, 1)
})

test('replay with a later timestamp is deterministic (first write wins)', async () => {
  const db = new FakeD1()
  const r = createPaymentsRepo(db)
  const first = await r.consume(input())
  assert.equal(first.outcome, 'accepted')
  assert.ok(first.record)
  const later = await r.consume(input({ at: '2026-02-02T00:00:00.000Z' }))
  assert.equal(later.outcome, 'already_consumed')
  assert.ok(later.record)
  assert.equal(later.record.consumedAt, first.record.consumedAt)
  assert.equal(later.record.id, first.record.id)
  assert.deepEqual(later.record, first.record)
})

test('25 interleaved consume attempts: exactly one accepted, rest already_consumed', async () => {
  const db = new FakeD1()
  const r = createPaymentsRepo(db)
  const base = input()
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      r.consume({ ...base, at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
    ),
  )
  const accepted = results.filter((x) => x.outcome === 'accepted')
  const consumed = results.filter((x) => x.outcome === 'already_consumed')
  assert.equal(accepted.length, 1)
  assert.equal(consumed.length, 24)
  for (const c of consumed) assert.deepEqual(c.record, accepted[0].record)
  assert.equal(db.raw('SELECT COUNT(*) c FROM payments')[0].c, 1)
  // the winning consumed_at belongs to the single accepted call
  const stored = rowToRecord((db.raw('SELECT * FROM payments') as Record<string, unknown>[])[0])
  assert.equal(stored.consumedAt, accepted[0].record.consumedAt)
})

test('same tx replayed under a different payment_id is an identity conflict', async () => {
  const r = repo()
  await r.consume(input())
  const res = await r.consume(input({ paymentId: 'pay-other' }))
  assert.equal(res.outcome, 'identity_conflict')
  assert.ok(res.record)
  assert.equal(res.record.paymentId, 'pay-1')
})

test('payment_id reused for a different tx (same player) is an identity conflict', async () => {
  const r = repo()
  await r.consume(input())
  const res = await r.consume(input({ txHash: tx('22') }))
  assert.equal(res.outcome, 'identity_conflict')
  assert.ok(res.record)
  assert.equal(res.record.txHash, tx('11'))
})

test('conflicting payment_id/tx_hash attempts are rejected deterministically on repeat', async () => {
  const db = new FakeD1()
  const r = createPaymentsRepo(db)
  const first = await r.consume(input())
  assert.equal(first.outcome, 'accepted')

  // Same tx replayed under different payment_ids: every attempt returns the
  // SAME identity_conflict + stored first-write-wins record.
  const txConflicts = await Promise.all([
    r.consume(input({ paymentId: 'pay-other' })),
    r.consume(input({ paymentId: 'pay-other' })),
    r.consume(input({ paymentId: 'pay-yet-another', at: '2026-03-03T00:00:00.000Z' })),
  ])
  for (const c of txConflicts) {
    assert.equal(c.outcome, 'identity_conflict')
    assert.deepEqual(c.record, first.record)
  }

  // payment_id reused for different txs (same player): same deterministic
  // rejection, always pointing at the stored owner row.
  const idConflicts = await Promise.all([
    r.consume(input({ txHash: tx('22') })),
    r.consume(input({ txHash: tx('22') })),
    r.consume(input({ txHash: tx('23'), amountWei: '5' })),
  ])
  for (const c of idConflicts) {
    assert.equal(c.outcome, 'identity_conflict')
    assert.ok(c.record)
    assert.equal(c.record.txHash, tx('11'))
  }

  // The rejections stored nothing new and left the consumed row untouched.
  assert.equal(db.raw('SELECT COUNT(*) c FROM payments')[0].c, 1)
  const stored = rowToRecord((db.raw('SELECT * FROM payments') as Record<string, unknown>[])[0])
  assert.deepEqual(stored, first.record)
})

test('payment_id is scoped per player: another player may reuse it (schema UNIQUE(player, payment_id))', async () => {
  const db = new FakeD1()
  const r = createPaymentsRepo(db)
  const first = await r.consume(input())
  assert.equal(first.outcome, 'accepted')
  // Different player + different tx reusing the same payment_id string is a
  // DISTINCT payment under UNIQUE (player, payment_id) — not a conflict.
  const res = await r.consume(input({ txHash: tx('33'), player: PLAYER2 }))
  assert.equal(res.outcome, 'accepted')
  assert.equal(res.record.player, PLAYER2)
  assert.equal(db.raw('SELECT COUNT(*) c FROM payments')[0].c, 2)
  // ...while the SAME player reusing it for another tx still conflicts
  const conflict = await r.consume(input({ txHash: tx('44') }))
  assert.equal(conflict.outcome, 'identity_conflict')
  assert.ok(conflict.record)
  assert.equal(conflict.record.txHash, tx('11'))
})

test('consuming an observed row transitions it to consumed (accepted)', async () => {
  const db = new FakeD1()
  db.raw(
    `INSERT INTO payments (id, chain_id, tx_hash, player, payment_id, amount_wei, block_number, status)
     VALUES ('seed-1', 46630, ?, ?, 'pay-1', '999', 1, 'observed')`,
    tx('44'),
    PLAYER,
  )
  const r = createPaymentsRepo(db)
  const res = await r.consume(input({ txHash: tx('44'), amountWei: '1000' }))
  assert.equal(res.outcome, 'accepted')
  assert.equal(res.record.status, 'consumed')
  assert.equal(res.record.id, 'seed-1') // existing row transitioned, not duplicated
  assert.equal(res.record.amountWei, '1000') // fresh verified amount wins on transition
  assert.equal(db.raw('SELECT COUNT(*) c FROM payments')[0].c, 1)
})

test('consuming a rejected payment is not consumable', async () => {
  const db = new FakeD1()
  db.raw(
    `INSERT INTO payments (id, chain_id, tx_hash, player, payment_id, amount_wei, status)
     VALUES ('seed-2', 46630, ?, ?, 'pay-1', '1', 'rejected')`,
    tx('55'),
    PLAYER,
  )
  const r = createPaymentsRepo(db)
  const res = await r.consume(input({ txHash: tx('55') }))
  assert.equal(res.outcome, 'not_consumable')
  assert.equal(res.record.status, 'rejected')
})

test('mainnet chain id 4663 is accepted and kept separate from 46630', async () => {
  const db = new FakeD1()
  const r = createPaymentsRepo(db)
  const t = await r.consume(input({ chainId: 4663, txHash: tx('66') }))
  assert.equal(t.outcome, 'accepted')
  // same tx hash on another chain is a DIFFERENT payment (unique per chain)
  const s = await r.consume(input({ chainId: 46630, txHash: tx('66'), paymentId: 'pay-2' }))
  assert.equal(s.outcome, 'accepted')
  assert.equal(db.raw('SELECT COUNT(*) c FROM payments')[0].c, 2)
})

test('schema CHECK violations propagate as errors (caller bug, not idempotency)', async () => {
  const r = repo()
  await assert.rejects(r.consume(input({ chainId: 1 })))
  await assert.rejects(r.consume(input({ txHash: '0x1234' })))
  // nothing was persisted by the rejected calls
  const db2 = new FakeD1()
  const r2 = createPaymentsRepo(db2)
  await assert.rejects(r2.consume(input({ chainId: 1 })))
  assert.equal(db2.raw('SELECT COUNT(*) c FROM payments')[0].c, 0)
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
  const r = createPaymentsRepo(explodingDb)
  await assert.rejects(r.consume(input()), (e: unknown) => e === failure)
  await assert.rejects(r.getByTxHash(46630, tx('11')), (e: unknown) => e === failure)
})

test('getByTxHash returns the stored record or null', async () => {
  const db = new FakeD1()
  const r = createPaymentsRepo(db)
  assert.equal(await r.getByTxHash(46630, tx('77')), null)
  const res = await r.consume(input({ txHash: tx('77') }))
  assert.deepEqual(await r.getByTxHash(46630, tx('77')), res.record)
  assert.equal(await r.getByTxHash(4663, tx('77')), null)
})
