/**
 * Focused route tests for the exact-origin CORS middleware in src/index.ts:
 *
 *   node --test apps/worker/test/corsRoute.test.ts
 *
 * (Also runs in-process — `node apps/worker/test/corsRoute.test.ts` — for
 * sandboxes that block the test runner's child-process spawning.)
 *
 * Contract under test (fail-closed, no wildcard):
 *   - Env.CORS_ORIGINS is the ONLY source of allowed origins; an Origin is
 *     echoed back only on an EXACT allowlist match.
 *   - Allowed origin → Access-Control-Allow-Origin (exact echo) + Vary: Origin
 *     on every actual response.
 *   - Disallowed origin / no origin / unset CORS_ORIGINS → NO allow-origin
 *     header, but the response itself is unchanged (200/404 as before).
 *   - Preflight (OPTIONS + Access-Control-Request-Method) is answered 204 by
 *     the middleware alone: allow-methods/allow-headers only when the request
 *     fits the fixed allowlists (authorization is explicitly allowed for
 *     credential-bearing API callers), never allow-credentials, and NEVER an
 *     RPC fetch. Bare OPTIONS without the preflight marker stays a 404.
 *
 * No network anywhere: synthetic env, *.invalid RPC URL, injected fetchImpl
 * whose call log doubles as the "preflight never reached the RPC" proof.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFetchHandler } from '../src/index.ts'
import type { Env } from '../src/config.ts'
import type { FetchLike } from '../src/rpc/fetchPrice.ts'

// ---- fixtures (synthetic; no real deployment or endpoint) -----------------------

const hex40 = (ch: string): string => '0x' + ch.repeat(40)

const ALLOWED_ORIGIN = 'https://game.example.com'
const OTHER_ALLOWED_ORIGIN = 'https://staging.game.example.com'
const DISALLOWED_ORIGIN = 'https://evil.example.net'

/** Staging/testnet env with a two-origin allowlist (one padded with a space). */
const FAKE_ENV: Env = {
  APP_ENV: 'staging',
  NETWORK: 'testnet',
  CHAIN_ID: '46630',
  RPC_URL: 'https://rpc.example.invalid/rpc',
  FRONG_ADDRESS: hex40('1'),
  ENTRY_ADDRESS: hex40('2'),
  TROPHY_ADDRESS: hex40('3'),
  BUILD_HASH: 'ab'.repeat(32),
  CORS_ORIGINS: ALLOWED_ORIGIN + ', ' + OTHER_ALLOWED_ORIGIN,
}

const WORKER_ORIGIN = 'https://worker.example'
const PRICE_WEI = 5_000_000_000_000_000_000n
const word = (value: bigint): string => '0x' + value.toString(16).padStart(64, '0')

/** Recording injected fetch: its log is the "did the RPC layer run?" proof. */
function recordingFetch(): { fetchImpl: FetchLike; calls: unknown[] } {
  const calls: unknown[] = []
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init })
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: word(PRICE_WEI) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return { fetchImpl, calls }
}

async function callRoute(
  path: string,
  env: Env,
  init?: RequestInit,
): Promise<{ res: Response; calls: unknown[] }> {
  const { fetchImpl, calls } = recordingFetch()
  const handler = createFetchHandler({ fetchImpl })
  const res = await handler.fetch(new Request(WORKER_ORIGIN + path, init), env)
  return { res, calls }
}

// ---- allowed origin (exact match) -----------------------------------------------

test('allowed origin is echoed exactly with Vary: Origin on /health', async () => {
  const { res, calls } = await callRoute('/health', FAKE_ENV, {
    headers: { origin: ALLOWED_ORIGIN },
  })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(res.headers.get('vary'), 'Origin')
  assert.equal(res.headers.get('access-control-allow-credentials'), null)
  assert.equal(calls.length, 0)
})

test('allowed origin rides along on /api/config without changing its behavior', async () => {
  const { res, body, calls } = await (async () => {
    const { fetchImpl, calls } = recordingFetch()
    const handler = createFetchHandler({ fetchImpl })
    const res = await handler.fetch(
      new Request(WORKER_ORIGIN + '/api/config', { headers: { origin: OTHER_ALLOWED_ORIGIN } }),
      FAKE_ENV,
    )
    return { res, body: (await res.json()) as Record<string, unknown>, calls }
  })()

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), OTHER_ALLOWED_ORIGIN)
  assert.equal(res.headers.get('vary'), 'Origin')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(body.feeAmount, PRICE_WEI.toString())
  // The route still makes its one LIVE RPC read — CORS never replaced routing.
  assert.equal(calls.length, 1)
})

test('a credential-bearing Authorization header from an allowed origin is served', async () => {
  const { res } = await callRoute('/health', FAKE_ENV, {
    headers: { origin: ALLOWED_ORIGIN, authorization: 'Bearer synthetic-test-token' },
  })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
})

// ---- disallowed / absent origin (fail closed) ------------------------------------

test('disallowed origin gets NO allow-origin but the same 200 body', async () => {
  const { res } = await callRoute('/health', FAKE_ENV, {
    headers: { origin: DISALLOWED_ORIGIN },
  })

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  assert.equal(res.headers.get('access-control-allow-credentials'), null)
})

test('near-miss origins never match: subdomains, suffixes, case, and null', async () => {
  for (const origin of [
    'https://sub.game.example.com',
    'https://game.example.com.attacker.example',
    'http://game.example.com', // wrong scheme is a different origin
    'null',
    ALLOWED_ORIGIN + '/',
  ]) {
    const { res } = await callRoute('/health', FAKE_ENV, { headers: { origin } })
    assert.equal(res.status, 200, origin)
    assert.equal(res.headers.get('access-control-allow-origin'), null, origin)
  }
})

test('no Origin header gets no CORS allow headers', async () => {
  const { res } = await callRoute('/health', FAKE_ENV)

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), null)
})

test('unset/empty CORS_ORIGINS allows no origin at all (no wildcard fallback)', async () => {
  for (const corsOrigins of [undefined, '', '   ']) {
    const env: Env = { ...FAKE_ENV, CORS_ORIGINS: corsOrigins }
    const { res } = await callRoute('/health', env, { headers: { origin: ALLOWED_ORIGIN } })
    assert.equal(res.status, 200, String(corsOrigins))
    assert.equal(res.headers.get('access-control-allow-origin'), null, String(corsOrigins))
  }
})

// ---- preflight --------------------------------------------------------------------

test('preflight from an allowed origin: 204, allow headers, ZERO RPC calls', async () => {
  const { res, calls } = await callRoute('/api/config', FAKE_ENV, {
    method: 'OPTIONS',
    headers: {
      origin: ALLOWED_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  })

  assert.equal(res.status, 204)
  assert.equal(await res.text(), '')
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  assert.equal(res.headers.get('access-control-allow-headers'), 'authorization, content-type')
  assert.equal(res.headers.get('vary'), 'Origin')
  assert.equal(res.headers.get('access-control-allow-credentials'), null)
  // The middleware answers alone: no config load, no eth_call.
  assert.equal(calls.length, 0, 'preflight must never invoke the RPC layer')
})

test('preflight from a disallowed origin: 204 with NO allow-origin, no RPC', async () => {
  const { res, calls } = await callRoute('/health', FAKE_ENV, {
    method: 'OPTIONS',
    headers: {
      origin: DISALLOWED_ORIGIN,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  })

  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  assert.equal(res.headers.get('access-control-allow-methods'), null)
  assert.equal(res.headers.get('access-control-allow-headers'), null)
  assert.equal(calls.length, 0)
})

test('preflight asking for a header outside the allowlist gets no allow-headers', async () => {
  const { res } = await callRoute('/health', FAKE_ENV, {
    method: 'OPTIONS',
    headers: {
      origin: ALLOWED_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, x-tracking',
    },
  })

  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(res.headers.get('access-control-allow-headers'), null)
})

test('preflight for a method outside the allowlist gets no allow-methods', async () => {
  const { res } = await callRoute('/health', FAKE_ENV, {
    method: 'OPTIONS',
    headers: {
      origin: ALLOWED_ORIGIN,
      'access-control-request-method': 'DELETE',
    },
  })

  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-methods'), null)
})

// ---- preserved behavior ------------------------------------------------------------

test('bare OPTIONS (no preflight marker) stays a 404 and never fetches', async () => {
  const { res, calls } = await callRoute('/api/config', FAKE_ENV, {
    method: 'OPTIONS',
    headers: { origin: ALLOWED_ORIGIN },
  })

  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { ok: false, error: 'not_found' })
  assert.equal(calls.length, 0)
})

test('unknown routes and non-GET methods keep their 404 with only Vary added', async () => {
  const missing = await callRoute('/api/nope', FAKE_ENV, { headers: { origin: ALLOWED_ORIGIN } })
  assert.equal(missing.res.status, 404)
  assert.equal(missing.res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(missing.calls.length, 0)

  const post = await callRoute('/api/config', FAKE_ENV, {
    method: 'POST',
    headers: { origin: ALLOWED_ORIGIN },
  })
  assert.equal(post.res.status, 404)
  assert.equal(post.res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(post.calls.length, 0)
})
