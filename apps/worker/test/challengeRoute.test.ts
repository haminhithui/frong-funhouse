/**
 * Focused route tests for POST /api/challenge (src/index.ts wiring +
 * src/auth/challenge.ts over src/auth/repo.ts and migration 0002):
 *
 *   node --test apps/worker/test/challengeRoute.test.ts
 *
 * (Also runs in-process — `node apps/worker/test/challengeRoute.test.ts` —
 * for sandboxes that block the test runner's child-process spawning.)
 *
 * Contract under test:
 *   - Success: {address} (any case) -> 200 {nonce, message, issuedAt} in
 *     the exact frontend shape; nonce is fresh 128-bit entropy; message is
 *     byte-identical to the Node server's SIWE message; address persisted
 *     lowercased.
 *   - Invalid address / malformed body -> structured 400, nothing stored.
 *   - D1 failure -> structured 500 (fail-closed, no store detail leaked);
 *     missing DB binding -> 503.
 *   - Expiry metadata: exactly one pending wallet_challenges row whose
 *     expires_at = issuedAt + 5 min and whose challenge_hash is the
 *     SHA-256 digest of the nonce.
 *   - Raw nonce never stored: no column of any row contains it.
 *   - CORS behavior is unchanged on this route (exact-origin echo, no
 *     allow-origin otherwise, preflight answered by the middleware alone
 *     without touching D1).
 *   - 404 regression: every other method/route combination stays 404.
 *
 * No network anywhere: synthetic env (CORS/chain vars), *.invalid RPC URL,
 * and a node:sqlite D1 fake built over the REAL migration SQL.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import { createFetchHandler } from '../src/index.ts'
import type { Env } from '../src/config.ts'
import type { D1DatabaseLike, D1StatementLike } from '../src/auth/repo.ts'
import { CHALLENGE_TTL_MS } from '../src/auth/challenge.ts'

// ---- D1 fake over the real migrations (same approach as authRepo.test.ts) -----

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
  /** Test hook: inspect rows directly. */
  raw(sql: string, ...params: SQLInputValue[]): Record<string, unknown>[] {
    return this.#db.prepare(sql).all(...params) as Record<string, unknown>[]
  }
}

/** D1 fake whose every statement rejects — the "D1 unavailable" case. */
function explodingD1(failure: Error): D1DatabaseLike {
  return {
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
}

// ---- fixtures (synthetic; no real deployment or endpoint) ----------------------

const hex40 = (ch: string): string => '0x' + ch.repeat(40)
const PLAYER = '0xAbC0000000000000000000000000000000000dE1' // mixed case on purpose
const PLAYER_LOWER = PLAYER.toLowerCase()

const ALLOWED_ORIGIN = 'https://game.example.com'
const DISALLOWED_ORIGIN = 'https://evil.example.net'
const WORKER_ORIGIN = 'https://worker.example'

/** Staging/testnet env; DB is attached per test (each FakeD1 is isolated). */
function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'staging',
    NETWORK: 'testnet',
    CHAIN_ID: '46630',
    RPC_URL: 'https://rpc.example.invalid/rpc',
    FRONG_ADDRESS: hex40('1'),
    ENTRY_ADDRESS: hex40('2'),
    TROPHY_ADDRESS: hex40('3'),
    BUILD_HASH: 'ab'.repeat(32),
    CORS_ORIGINS: ALLOWED_ORIGIN,
    ...overrides,
  }
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

async function postChallenge(
  env: Env,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ res: Response; json: Record<string, unknown> }> {
  const handler = createFetchHandler()
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await handler.fetch(new Request(WORKER_ORIGIN + '/api/challenge', init), env)
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    json = {}
  }
  return { res, json }
}

/** The single stored wallet_challenges row (fails loudly when absent). */
function storedRow(db: FakeD1): Record<string, unknown> {
  const rows = db.raw('SELECT * FROM wallet_challenges')
  assert.equal(rows.length, 1, 'exactly one challenge row expected')
  return rows[0]
}

// ---- success ---------------------------------------------------------------------

test('success: {address} returns nonce/message/issuedAt in the frontend shape and persists the digest', async () => {
  const db = new FakeD1()
  const { res, json } = await postChallenge({ ...fakeEnv(), DB: db }, { address: PLAYER })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Object.keys(json).sort(), ['issuedAt', 'message', 'nonce'])

  const nonce = json.nonce
  const message = json.message
  const issuedAt = json.issuedAt
  assert.match(String(nonce), /^[0-9a-f]{32}$/) // 128 bits, hex, client-visible
  assert.equal(typeof issuedAt, 'string')
  const issuedMs = Date.parse(String(issuedAt))
  assert.ok(!Number.isNaN(issuedMs), 'issuedAt is ISO-8601')
  assert.ok(Math.abs(issuedMs - Date.now()) < 60_000, 'issuedAt is the current clock')
  // message is byte-identical to the Node server's SIWE payload, carrying
  // the lowercased address and the CONFIGURED chain id (staging -> 46630)
  assert.equal(
    message,
    [
      'frong-catch.fan wants you to sign in with your wallet.',
      '',
      'Address: ' + PLAYER_LOWER,
      'Nonce: ' + nonce,
      'Issued At: ' + issuedAt,
      'Chain ID: 46630',
    ].join('\n'),
  )

  // durable metadata: one pending row, digest-only, lowercased player
  const row = storedRow(db)
  assert.equal(String(row.player), PLAYER_LOWER)
  assert.equal(String(row.status), 'pending')
  assert.equal(String(row.challenge_hash), sha256(String(nonce)))
  assert.equal(String(row.created_at), issuedAt)
  assert.equal(row.consumed_at, null)
  assert.equal(row.payment_id, null)
})

test('success: two calls draw distinct nonces and store two independently digested rows', async () => {
  const db = new FakeD1()
  const env = { ...fakeEnv(), DB: db }
  const first = await postChallenge(env, { address: PLAYER_LOWER })
  const second = await postChallenge(env, { address: PLAYER_LOWER })
  assert.equal(first.res.status, 200)
  assert.equal(second.res.status, 200)
  assert.notEqual(first.json.nonce, second.json.nonce, 'nonce entropy is fresh per call')
  const rows = db.raw('SELECT challenge_hash FROM wallet_challenges')
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((r) => String(r.challenge_hash)).sort(),
    [sha256(String(first.json.nonce)), sha256(String(second.json.nonce))].sort(),
  )
})

// ---- invalid address / malformed body ----------------------------------------------

test('invalid address or malformed body is a structured 400 and stores nothing', async () => {
  const db = new FakeD1()
  const env = { ...fakeEnv(), DB: db }
  for (const body of [
    {},
    { address: 'not-an-address' },
    { address: '0x1234' },
    { address: '0x' + 'zz'.repeat(20) },
    { address: '0x' + '0'.repeat(40) }, // zero address is not a player
    { address: '' },
    { address: 42 },
    { address: null },
    { address: [PLAYER_LOWER] },
    'a plain string',
    null,
  ]) {
    const { res, json } = await postChallenge(env, body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.deepEqual(
      { ok: json.ok, error: json.error },
      { ok: false, error: 'valid wallet address required' },
      JSON.stringify(body),
    )
  }
  // malformed JSON body -> same 400
  const malformed = await postChallenge(env, '{not json')
  assert.equal(malformed.res.status, 400)
  assert.equal(malformed.json.error, 'valid wallet address required')
  // nothing was ever persisted
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 0)
})

// ---- D1 failure / missing binding ---------------------------------------------------

test('a failing D1 is a structured 500 with no store detail leaked', async () => {
  const failure = new Error('D1 unavailable: disk I/O error SECRET-DETAIL')
  const { res, json } = await postChallenge({ ...fakeEnv(), DB: explodingD1(failure) }, {
    address: PLAYER_LOWER,
  })
  assert.equal(res.status, 500)
  assert.deepEqual(
    { ok: json.ok, error: json.error },
    { ok: false, error: 'could not issue challenge' },
  )
  const text = JSON.stringify(json)
  assert.ok(!text.includes('SECRET-DETAIL'), 'store errors never reach the client')
  assert.ok(!text.includes('nonce'), 'no nonce is returned on failure')
})

test('a missing DB binding fails closed with 503 and touches nothing', async () => {
  const db = new FakeD1()
  const { res, json } = await postChallenge(fakeEnv(), { address: PLAYER_LOWER }) // no DB attached
  assert.equal(res.status, 503)
  assert.deepEqual(
    { ok: json.ok, error: json.error },
    { ok: false, error: 'auth store unavailable' },
  )
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 0)
})

// ---- expiry metadata --------------------------------------------------------------

test('expiry metadata: pending row whose expires_at is issuedAt + the 5-minute TTL', async () => {
  const db = new FakeD1()
  const { res, json } = await postChallenge({ ...fakeEnv(), DB: db }, { address: PLAYER_LOWER })
  assert.equal(res.status, 200)
  const row = storedRow(db)
  const expectedExpiry = new Date(Date.parse(String(json.issuedAt)) + CHALLENGE_TTL_MS).toISOString()
  assert.equal(String(row.expires_at), expectedExpiry)
  assert.equal(String(row.status), 'pending')
  assert.equal(String(row.created_at), String(json.issuedAt))
  assert.equal(row.consumed_at, null) // issuance never consumes
})

test('an invalid configured chain fails closed with 503 before any challenge is stored', async () => {
  const db = new FakeD1()
  const { res, json } = await postChallenge(
    { ...fakeEnv(), CHAIN_ID: '999', DB: db },
    { address: PLAYER_LOWER },
  )
  assert.equal(res.status, 503)
  assert.equal(json.error, 'worker configuration invalid')
  assert.ok(Array.isArray(json.problems) && json.problems.length > 0)
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 0)
})

// ---- raw nonce is never stored ------------------------------------------------------

test('the raw nonce appears nowhere in any stored row or table', async () => {
  const db = new FakeD1()
  const { json } = await postChallenge({ ...fakeEnv(), DB: db }, { address: PLAYER_LOWER })
  const nonce = String(json.nonce)

  const rows = db.raw('SELECT * FROM wallet_challenges')
  assert.equal(rows.length, 1)
  for (const [column, value] of Object.entries(rows[0])) {
    assert.ok(
      !String(value).includes(nonce),
      `column ${column} must not contain the raw nonce`,
    )
  }
  const digest = String(rows[0].challenge_hash)
  assert.equal(digest, sha256(nonce))
  assert.equal(digest.length, 64)
  assert.notEqual(digest, nonce, 'the stored digest is not the nonce')
  // no signature-shaped or token rows exist either
  assert.equal(db.raw('SELECT COUNT(*) c FROM auth_tokens')[0].c, 0)
  assert.equal(rows[0].consumed_at, null)
  // and the response carries no digest back to the client
  assert.ok(!JSON.stringify(json).includes(digest))
})

// ---- CORS (unchanged exact-origin behavior on the new route) ------------------------

test('allowed origin is echoed exactly on POST /api/challenge; others get no allow-origin', async () => {
  const db = new FakeD1()
  const env = { ...fakeEnv(), DB: db }

  const allowed = await postChallenge(env, { address: PLAYER_LOWER }, { origin: ALLOWED_ORIGIN })
  assert.equal(allowed.res.status, 200)
  assert.equal(allowed.res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(allowed.res.headers.get('vary'), 'Origin')
  assert.equal(allowed.res.headers.get('access-control-allow-credentials'), null)

  const disallowed = await postChallenge(env, { address: PLAYER_LOWER }, { origin: DISALLOWED_ORIGIN })
  assert.equal(disallowed.res.status, 200) // CORS never changed the response itself
  assert.equal(disallowed.res.headers.get('access-control-allow-origin'), null)

  const none = await postChallenge(env, { address: PLAYER_LOWER })
  assert.equal(none.res.status, 200)
  assert.equal(none.res.headers.get('access-control-allow-origin'), null)
  assert.equal(none.res.headers.get('vary'), 'Origin')
})

test('preflight for the challenge route is answered by the middleware alone, never D1', async () => {
  const handler = createFetchHandler()
  // an exploding D1 proves the middleware never reached the store
  const res = await handler.fetch(
    new Request(WORKER_ORIGIN + '/api/challenge', {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    }),
    { ...fakeEnv(), DB: explodingD1(new Error('must not be touched')) },
  )
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  assert.equal(res.headers.get('access-control-allow-headers'), 'content-type')
  assert.equal(res.headers.get('access-control-allow-credentials'), null)
})

// ---- 404 regression ------------------------------------------------------------------

test('404 regression: other methods and routes keep their 404', async () => {
  const db = new FakeD1()
  const env = { ...fakeEnv(), DB: db }
  const handler = createFetchHandler()

  const cases: { method: string; path: string; body?: string }[] = [
    { method: 'GET', path: '/api/challenge' },
    { method: 'PUT', path: '/api/challenge', body: JSON.stringify({ address: PLAYER_LOWER }) },
    { method: 'DELETE', path: '/api/challenge' },
    { method: 'POST', path: '/api/challenge/extra', body: JSON.stringify({ address: PLAYER_LOWER }) },
    { method: 'POST', path: '/api/verify', body: JSON.stringify({ address: PLAYER_LOWER }) },
    { method: 'POST', path: '/api/nope', body: '{}' },
    { method: 'OPTIONS', path: '/api/challenge' }, // bare OPTIONS: no preflight marker
  ]
  for (const { method, path, body } of cases) {
    const res = await handler.fetch(
      new Request(WORKER_ORIGIN + path, { method, body, headers: { origin: ALLOWED_ORIGIN } }),
      env,
    )
    assert.equal(res.status, 404, method + ' ' + path)
    assert.deepEqual(await res.json(), { ok: false, error: 'not_found' }, method + ' ' + path)
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN, method + ' ' + path)
  }
  // nothing was persisted by any of them
  assert.equal(db.raw('SELECT COUNT(*) c FROM wallet_challenges')[0].c, 0)
})
