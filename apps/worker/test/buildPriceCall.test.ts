/**
 * Focused tests for the pure JSON-RPC eth_call request builder
 * (src/rpc/buildPriceCall.ts). Runs on Node's built-in test runner:
 *
 *   node --test apps/worker/test/buildPriceCall.test.ts
 *
 * (The same file also runs in-process — `node apps/worker/test/
 * buildPriceCall.test.ts` — for sandboxes that block the runner's
 * child-process spawning.)
 *
 * The builder is pure: it receives plain strings and returns plain objects,
 * with no fetch, no timeout, no URL, no viem and no global state, so every
 * case is a literal. All addresses are synthetic fixture words — no real
 * contract address or RPC URL appears anywhere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPriceCallRequest,
  PRICE_CALL_SELECTOR,
  type BuildPriceCallResult,
  type PriceCallRequest,
} from '../src/rpc/buildPriceCall.ts'

// ---- helpers ----------------------------------------------------------------

/** Unwrap the built body or fail the test with the failure payload. */
function bodyOf(res: BuildPriceCallResult): PriceCallRequest {
  if (!res.ok) assert.fail('expected ok result, got ' + res.code + ': ' + res.message)
  return res.body
}

/** Unwrap a failure code or fail the test because the build succeeded. */
function codeOf(res: BuildPriceCallResult): string {
  if (res.ok) assert.fail('expected failure, got ok with a built body')
  return res.code
}

/** Synthetic fixtures: repeated/sequential nibble words, never a real deploy. */
const FIXTURE_ENTRY = '0x' + '1'.repeat(40)
const FIXTURE_ENTRY_MIXED_CASE = '0xAbCdEf0102030405060708090a0b0c0d0e0f1011'

// ---- valid addresses: exact wire shape ----------------------------------------

test('selector constant is exactly the price() selector', () => {
  assert.equal(PRICE_CALL_SELECTOR, '0xc69c4ec9')
  assert.equal(PRICE_CALL_SELECTOR.length, 10)
})

test('builds the exact JSON-RPC 2.0 eth_call body for a valid address', () => {
  assert.deepEqual(bodyOf(buildPriceCallRequest(FIXTURE_ENTRY)), {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: FIXTURE_ENTRY, data: '0xc69c4ec9' }, 'latest'],
  })
})

test('carries exactly the fixed protocol values: 2.0, id 1, eth_call, latest', () => {
  const body = bodyOf(buildPriceCallRequest(FIXTURE_ENTRY))
  assert.equal(body.jsonrpc, '2.0')
  assert.equal(body.id, 1)
  assert.equal(body.method, 'eth_call')
  assert.equal(body.params.length, 2)
  assert.equal(body.params[1], 'latest')
})

test('targets the validated address verbatim and nothing else', () => {
  const [target] = bodyOf(buildPriceCallRequest(FIXTURE_ENTRY)).params
  assert.equal(target.to, FIXTURE_ENTRY)
  assert.equal(target.data, '0xc69c4ec9')
  assert.deepEqual(Object.keys(target).sort(), ['data', 'to'])
})

test('accepts uppercase and mixed-case hex digits, passed through verbatim', () => {
  const [target] = bodyOf(buildPriceCallRequest(FIXTURE_ENTRY_MIXED_CASE)).params
  assert.equal(target.to, FIXTURE_ENTRY_MIXED_CASE)
})

test('serializes to the exact wire body via JSON.stringify', () => {
  const body = bodyOf(buildPriceCallRequest(FIXTURE_ENTRY))
  assert.deepEqual(JSON.parse(JSON.stringify(body)), {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: FIXTURE_ENTRY, data: '0xc69c4ec9' }, 'latest'],
  })
})

// ---- purity -------------------------------------------------------------------

test('pure: repeated calls build fresh, deep-equal bodies (no shared state)', () => {
  const first = bodyOf(buildPriceCallRequest(FIXTURE_ENTRY))
  const second = bodyOf(buildPriceCallRequest(FIXTURE_ENTRY))
  assert.deepEqual(first, second)
  assert.notEqual(first, second)
  assert.notEqual(first.params[0], second.params[0])

  // Mutating one returned body must not leak into the next build. (The
  // params tuple is typed ['latest'], so the mutations below stick to the
  // assignable fields: id, to and data.)
  first.id = 999
  first.params[0].to = '0x' + 'f'.repeat(40)
  first.params[0].data = '0xdeadbeef'
  const third = bodyOf(buildPriceCallRequest(FIXTURE_ENTRY))
  assert.equal(third.id, 1)
  assert.equal(third.params[0].to, FIXTURE_ENTRY)
  assert.equal(third.params[0].data, '0xc69c4ec9')
  assert.equal(third.params[1], 'latest')
})

test('does not mutate or normalize the input address', () => {
  const input = FIXTURE_ENTRY_MIXED_CASE
  buildPriceCallRequest(input)
  assert.equal(input, FIXTURE_ENTRY_MIXED_CASE)
})

// ---- invalid addresses: rejected BEFORE any body is built ----------------------

test('rejects non-string inputs', () => {
  for (const bad of [undefined, null, 42, true, {}, ['0x' + '1'.repeat(40)]]) {
    assert.equal(
      codeOf(buildPriceCallRequest(bad)),
      'invalid_address',
      'input: ' + String(bad),
    )
  }
})

test('rejects addresses without a literal lowercase 0x prefix', () => {
  assert.equal(codeOf(buildPriceCallRequest('1'.repeat(40))), 'invalid_address')
  assert.equal(codeOf(buildPriceCallRequest('0X' + '1'.repeat(40))), 'invalid_address')
  assert.equal(codeOf(buildPriceCallRequest('')), 'invalid_address')
})

test('rejects addresses that are not exactly 40 hex digits', () => {
  assert.equal(codeOf(buildPriceCallRequest('0x' + '1'.repeat(39))), 'invalid_address')
  assert.equal(codeOf(buildPriceCallRequest('0x' + '1'.repeat(41))), 'invalid_address')
  assert.equal(codeOf(buildPriceCallRequest('0x')), 'invalid_address')
})

test('rejects non-hex digits inside the address', () => {
  assert.equal(
    codeOf(buildPriceCallRequest('0x' + 'z'.repeat(40))),
    'invalid_address',
  )
  assert.equal(
    codeOf(buildPriceCallRequest('0x' + 'g'.repeat(40))),
    'invalid_address',
  )
})

test('rejects padded or whitespace-wrapped addresses', () => {
  assert.equal(codeOf(buildPriceCallRequest(' ' + FIXTURE_ENTRY)), 'invalid_address')
  assert.equal(codeOf(buildPriceCallRequest(FIXTURE_ENTRY + '\n')), 'invalid_address')
  assert.equal(
    codeOf(buildPriceCallRequest('0x0x' + '1'.repeat(40))),
    'invalid_address',
  )
})

test('rejects the all-zero address', () => {
  assert.equal(codeOf(buildPriceCallRequest('0x' + '0'.repeat(40))), 'invalid_address')
})

test('failure messages name the problem without throwing', () => {
  const res = buildPriceCallRequest('0x1234')
  assert.equal(codeOf(res), 'invalid_address')
  assert.ok(!res.ok && res.message.length > 0)
})
