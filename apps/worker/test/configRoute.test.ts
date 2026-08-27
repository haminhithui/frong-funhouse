/**
 * Focused route tests for GET /api/config (src/index.ts) plus the preserved
 * /health and 404 behavior. Runs on Node's built-in test runner:
 *
 *   node --test apps/worker/test/configRoute.test.ts
 *
 * (The same file also runs in-process — `node apps/worker/test/
 * configRoute.test.ts` — for sandboxes that block the runner's
 * child-process spawning.)
 *
 * No network anywhere: the environment is a fake Env (synthetic hex words
 * and an *.invalid RPC URL — never a real contract or endpoint) and the whole
 * HTTP layer is injected via `fetchImpl`, while the REAL createPriceFetcher
 * transport (request building, parsing, failure classification) still runs
 * behind the route. The contract under test is the fail-closed one from the
 * route header: feeAmount is the LIVE RPC word — never a stale
 * FEE_AMOUNT_WEI — and every config/RPC failure is a structured 503.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFetchHandler } from '../src/index.ts'
import type { Env } from '../src/config.ts'
import type { FetchLike } from '../src/rpc/fetchPrice.ts'

// ---- fixtures (synthetic; no real deployment or endpoint) ---------------------

const hex40 = (ch: string): string => '0x' + ch.repeat(40)

/** Staging/testnet env; also carries a stale FEE_AMOUNT_WEI the route must ignore. */
const FAKE_ENV: Env & { FEE_AMOUNT_WEI?: string } = {
  APP_ENV: 'staging',
  NETWORK: 'testnet',
  CHAIN_ID: '46630',
  RPC_URL: 'https://rpc.example.invalid/rpc',
  FRONG_ADDRESS: hex40('1'),
  ENTRY_ADDRESS: hex40('2'),
  TROPHY_ADDRESS: hex40('3'),
  BUILD_HASH: 'ab'.repeat(32),
  FEE_AMOUNT_WEI: '12345',
}

const PRICE_WEI = 5_000_000_000_000_000_000n
const word = (value: bigint): string => '0x' + value.toString(16).padStart(64, '0')

/** One captured mocked RPC call, enough to prove the exact wire shape. */
interface CapturedCall {
  input: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

/** Recording mock: queues Responses/Errors; every call is captured. */
function recordingFetch(
  behavior: Array<Response | Error>,
): { fetchImpl: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, ...init })
    const next = behavior.shift()
    if (next === undefined) {
      return Promise.reject(new Error('recordingFetch: no queued behavior left'))
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }
  return { fetchImpl, calls }
}

/** 2xx JSON-RPC envelope response. */
const rpcOk = (result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const WORKER_ORIGIN = 'https://worker.example'

/** Invoke the exported handler with a plain (runtime-agnostic) signature. */
async function callRoute(
  behavior: Array<Response | Error>,
  path: string,
  env: Env,
  init?: RequestInit,
): Promise<{ res: Response; body: Record<string, unknown>; calls: CapturedCall[] }> {
  const { fetchImpl, calls } = recordingFetch(behavior)
  const handler = createFetchHandler({ fetchImpl })
  const res = await handler.fetch(new Request(WORKER_ORIGIN + path, init), env)
  const body = (await res.json()) as Record<string, unknown>
  return { res, body, calls }
}

// ---- success -------------------------------------------------------------------

test('GET /api/config returns the frontend shape with the LIVE RPC price', async () => {
  const { res, body, calls } = await callRoute([rpcOk(word(PRICE_WEI))], '/api/config', FAKE_ENV)

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(body, {
    chainId: 46630,
    frong: FAKE_ENV.FRONG_ADDRESS,
    entry: FAKE_ENV.ENTRY_ADDRESS,
    trophy: FAKE_ENV.TROPHY_ADDRESS,
    feeAmount: PRICE_WEI.toString(),
    countdownTicks: 180,
    durationTicks: 3600,
    buildHash: FAKE_ENV.BUILD_HASH,
  })

  // Exactly one LIVE eth_call against the env RPC URL and entry address —
  // never a cached, default, or FEE_AMOUNT_WEI-derived value.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input, FAKE_ENV.RPC_URL)
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: FAKE_ENV.ENTRY_ADDRESS, data: '0xc69c4ec9' }, 'latest'],
  })
})

// ---- missing / invalid configuration -------------------------------------------

test('GET /api/config with an empty env is a structured 503 and never fetches', async () => {
  const { res, body, calls } = await callRoute([rpcOk(word(PRICE_WEI))], '/api/config', {} as Env)

  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(body.ok, false)
  assert.equal(body.error, 'worker configuration invalid')
  assert.ok(Array.isArray(body.problems) && body.problems.length > 0)
  assert.equal('feeAmount' in body, false, 'a config failure must never serve a fee')
  assert.equal(calls.length, 0, 'invalid config must fail closed before any network call')
})

test('GET /api/config with one invalid var reports that concrete problem', async () => {
  const { res, body, calls } = await callRoute(
    [rpcOk(word(PRICE_WEI))],
    '/api/config',
    { ...FAKE_ENV, BUILD_HASH: 'deadbeef' },
  )

  assert.equal(res.status, 503)
  assert.equal(body.ok, false)
  assert.ok(
    (body.problems as string[]).some((p) => p.includes('BUILD_HASH')),
    'the 503 lists the concrete problem: ' + JSON.stringify(body.problems),
  )
  assert.equal(calls.length, 0)
})

// ---- RPC failures ----------------------------------------------------------------

test('GET /api/config maps an RPC outage to a structured 503, no fee served', async () => {
  const { res, body, calls } = await callRoute(
    [new Response('upstream down', { status: 502 })],
    '/api/config',
    FAKE_ENV,
  )

  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(body.ok, false)
  assert.equal(body.error, 'could not read the on-chain price')
  assert.equal(body.code, 'rpc_unreachable')
  assert.equal('feeAmount' in body, false)
  assert.equal(calls.length, 1)
})

test('GET /api/config fails closed on a zero price and a JSON-RPC error', async () => {
  for (const [label, response, code] of [
    ['zero price', rpcOk('0x00'), 'zero_price'],
    ['json-rpc error', rpcOkError(), 'rpc_error'],
  ] as const) {
    const { res, body } = await callRoute([response], '/api/config', FAKE_ENV)
    assert.equal(res.status, 503, label)
    assert.equal(body.ok, false, label)
    assert.equal(body.code, code, label)
    assert.equal('feeAmount' in body, false, label)
  }
})

/** 2xx JSON-RPC error envelope. */
function rpcOkError(): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'revert' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// ---- preserved behavior -----------------------------------------------------------

test('GET /health stays 200 with its payload and no RPC call', async () => {
  const { res, body, calls } = await callRoute([], '/health', {} as Env)

  assert.equal(res.status, 200)
  assert.deepEqual(body, { ok: true, service: 'frong-catch-worker' })
  assert.equal(calls.length, 0)
})

test('unknown routes and non-GET methods stay 404', async () => {
  const missing = await callRoute([], '/api/nope', FAKE_ENV)
  assert.equal(missing.res.status, 404)
  assert.deepEqual(missing.body, { ok: false, error: 'not_found' })
  assert.equal(missing.calls.length, 0)

  const post = await callRoute([], '/api/config', FAKE_ENV, { method: 'POST' })
  assert.equal(post.res.status, 404)
  assert.deepEqual(post.body, { ok: false, error: 'not_found' })
  assert.equal(post.calls.length, 0)
})
