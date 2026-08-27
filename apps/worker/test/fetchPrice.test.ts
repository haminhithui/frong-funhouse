/**
 * Focused mocked tests for the fetch-based price RPC transport
 * (src/rpc/fetchPrice.ts). Runs on Node's built-in test runner:
 *
 *   node --test apps/worker/test/fetchPrice.test.ts
 *
 * (The same file also runs in-process — `node apps/worker/test/
 * fetchPrice.test.ts` — for sandboxes that block the runner's
 * child-process spawning.)
 *
 * The whole HTTP layer is injected via `fetchImpl`: there is no network,
 * no viem, no process.env and no Workers runtime anywhere in this file.
 * Fixtures are synthetic hex words and a fake http(s) URL — no real
 * contract address or RPC endpoint appears anywhere. The contract under
 * test is the fail-closed one from the module header: fetchPrice ALWAYS
 * resolves, NEVER throws, and NEVER fabricates or falls back to a price.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPriceFetcher,
  type FetchLike,
  type PriceRpcResult,
  type PriceRpcSource,
} from '../src/rpc/fetchPrice.ts'
import {
  buildPriceCallRequest,
  type BuildPriceCallResult,
  type PriceCallRequest,
} from '../src/rpc/buildPriceCall.ts'

// ---- helpers ----------------------------------------------------------------

/** Unwrap a success price or fail the test with the failure payload. */
function priceWeiOf(res: PriceRpcResult): bigint {
  if (!res.ok) assert.fail('expected ok result, got ' + res.code + ': ' + res.message)
  return res.priceWei
}

/** Unwrap a failure or fail the test because the fetch succeeded. */
function failureOf(res: PriceRpcResult): { code: string; message: string; retryable: boolean } {
  if (res.ok) assert.fail('expected failure, got ok with ' + res.priceWei.toString() + ' wei')
  assert.ok(!('priceWei' in res), 'a failure must never carry a priceWei')
  return { code: res.code, message: res.message, retryable: res.retryable }
}

/** Unwrap the built body or fail the test (parity cross-check only). */
function bodyOf(res: BuildPriceCallResult): PriceCallRequest {
  if (!res.ok) assert.fail('expected ok result, got ' + res.code + ': ' + res.message)
  return res.body
}

/** Synthetic fixtures — never a real deployment or endpoint. */
const FIXTURE_SOURCE: PriceRpcSource = {
  rpcUrl: 'https://rpc.example.invalid/rpc',
  entryAddress: '0x' + '1'.repeat(40),
}
const TWO_ETH_WEI = 2_000_000_000_000_000_000n
const word = (value: bigint): string => '0x' + value.toString(16).padStart(64, '0')

/** One captured mocked call, enough to prove the exact wire shape. */
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
const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Well-formed eth_call success envelope around a fake price word. */
const envelope = (result: unknown): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: 1,
  result,
})

// ---- successful live price -----------------------------------------------------

test('resolves the live price from a 2xx JSON-RPC success envelope', async () => {
  const { fetchImpl } = recordingFetch([jsonResponse(envelope(word(TWO_ETH_WEI)))])
  const res = await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice()
  assert.equal(priceWeiOf(res), TWO_ETH_WEI)
})

test('puts the exact buildPriceCall wire shape on the HTTP layer', async () => {
  const { fetchImpl, calls } = recordingFetch([jsonResponse(envelope('0x01'))])
  await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].input, FIXTURE_SOURCE.rpcUrl)
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].headers, { 'content-type': 'application/json' })
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.equal(calls[0].signal.aborted, false)
  // Parity with the pure request builder: identical calldata on the wire.
  assert.deepEqual(JSON.parse(calls[0].body), bodyOf(buildPriceCallRequest(FIXTURE_SOURCE.entryAddress)))
})

// ---- non-2xx / transport failures ------------------------------------------------

test('maps a 503 HTTP status to rpc_unreachable (retryable)', async () => {
  const { fetchImpl } = recordingFetch([new Response('service unavailable', { status: 503 })])
  const res = await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice()
  const f = failureOf(res)
  assert.equal(f.code, 'rpc_unreachable')
  assert.equal(f.retryable, true)
  assert.match(f.message, /HTTP 503/)
})

test('maps a 4xx HTTP status to rpc_unreachable (retryable)', async () => {
  const { fetchImpl } = recordingFetch([new Response('nope', { status: 401 })])
  const f = failureOf(await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice())
  assert.equal(f.code, 'rpc_unreachable')
  assert.equal(f.retryable, true)
})

test('maps a network error (no abort) to rpc_unreachable, not rpc_timeout', async () => {
  const { fetchImpl } = recordingFetch([new TypeError('fetch failed')])
  const f = failureOf(await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice())
  assert.equal(f.code, 'rpc_unreachable')
  assert.equal(f.retryable, true)
})

// ---- timeout / abort --------------------------------------------------------------

test('maps the timeout AbortSignal firing to rpc_timeout (retryable)', async () => {
  // A fetch that hangs until the transport's own signal aborts it, then
  // rejects exactly like a real fetch does — with our timeoutMs at 10ms
  // the outcome is deterministic without any test-side sleeping.
  const hanging: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => reject(new Error('This operation was aborted')),
        { once: true },
      )
    })
  const f = failureOf(
    await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl: hanging, timeoutMs: 10 }).fetchPrice(),
  )
  assert.equal(f.code, 'rpc_timeout')
  assert.equal(f.retryable, true)
  assert.match(f.message, /10ms/)
})

// ---- malformed JSON ----------------------------------------------------------------

test('maps a 2xx non-JSON body to malformed_json (not retryable)', async () => {
  const { fetchImpl } = recordingFetch([
    new Response('<html>502 Bad Gateway</html>', { status: 200 }),
  ])
  const f = failureOf(await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice())
  assert.equal(f.code, 'malformed_json')
  assert.equal(f.retryable, false)
})

// ---- JSON-RPC error ------------------------------------------------------------------

test('passes a JSON-RPC error through as rpc_error (retryable)', async () => {
  const { fetchImpl } = recordingFetch([
    jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'revert' } }),
  ])
  const f = failureOf(await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice())
  assert.equal(f.code, 'rpc_error')
  assert.equal(f.retryable, true)
  assert.match(f.message, /-32000 revert/)
})

// ---- parser failure passthrough ---------------------------------------------------

test('passes a zero price through as zero_price (not retryable)', async () => {
  const { fetchImpl } = recordingFetch([jsonResponse(envelope('0x00'))])
  const f = failureOf(await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice())
  assert.equal(f.code, 'zero_price')
  assert.equal(f.retryable, false)
})

test('passes a missing result through as missing_result (not retryable)', async () => {
  const { fetchImpl } = recordingFetch([jsonResponse({ jsonrpc: '2.0', id: 1 })])
  const f = failureOf(await createPriceFetcher(FIXTURE_SOURCE, { fetchImpl }).fetchPrice())
  assert.equal(f.code, 'missing_result')
  assert.equal(f.retryable, false)
})

// ---- no stale fallback, no fabricated price ----------------------------------------

test('never serves a stale success: a later outage stays a failure', async () => {
  const { fetchImpl } = recordingFetch([
    jsonResponse(envelope(word(TWO_ETH_WEI))),
    new Response('upstream down', { status: 502 }),
  ])
  const fetcher = createPriceFetcher(FIXTURE_SOURCE, { fetchImpl })
  assert.equal(priceWeiOf(await fetcher.fetchPrice()), TWO_ETH_WEI)
  const f = failureOf(await fetcher.fetchPrice())
  assert.equal(f.code, 'rpc_unreachable')
})

test('rejects an invalid source before any HTTP call (fail closed, no fetch)', async () => {
  const { fetchImpl, calls } = recordingFetch([jsonResponse(envelope('0x01'))])
  const f = failureOf(
    await createPriceFetcher(
      { rpcUrl: 'ftp://not-http.example.invalid', entryAddress: '0x' + '0'.repeat(40) },
      { fetchImpl, timeoutMs: 0 },
    ).fetchPrice(),
  )
  assert.equal(f.code, 'invalid_source')
  assert.equal(f.retryable, false)
  assert.match(f.message, /rpcUrl must be an http\(s\) URL/)
  assert.match(f.message, /non-zero 20-byte hex address/)
  assert.match(f.message, /timeoutMs must be a positive integer/)
  assert.equal(calls.length, 0, 'invalid source must never reach the HTTP layer')
})
