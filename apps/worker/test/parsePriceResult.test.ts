/**
 * Focused tests for the pure JSON-RPC price-result parser
 * (src/rpc/parsePriceResult.ts). Runs on Node's built-in test runner:
 *
 *   node --test apps/worker/test/parsePriceResult.test.ts
 *
 * (The same file also runs in-process — `node apps/worker/test/
 * parsePriceResult.test.ts` — for sandboxes that block the runner's
 * child-process spawning.)
 *
 * The parser is pure: it receives already-parsed JSON values and never
 * touches fetch, viem, process.env or any global state, so every case is a
 * plain literal. Fixtures are synthetic hex words and fake JSON-RPC
 * envelopes — no real contract address or RPC URL appears anywhere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePriceResult, type RpcPriceResult } from '../src/rpc/parsePriceResult.ts'

// ---- helpers ----------------------------------------------------------------

/** Unwrap a success or fail the test with the failure payload. */
function priceWeiOf(res: RpcPriceResult): bigint {
  if (!res.ok) assert.fail('expected ok result, got ' + res.code + ': ' + res.message)
  return res.priceWei
}

/** Unwrap a failure code or fail the test because the parse succeeded. */
function codeOf(res: RpcPriceResult): string {
  if (res.ok) assert.fail('expected failure, got ok with ' + res.priceWei.toString() + ' wei')
  return res.code
}

/** Well-formed eth_call success envelope around a fake price word. */
const envelope = (result: unknown): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: 1,
  result,
})

/** Left-pad a value to the full ABI-encoded 32-byte word shape. */
const word = (value: bigint): string => '0x' + value.toString(16).padStart(64, '0')

const TWO_ETH_WEI = 2_000_000_000_000_000_000n
const UINT256_MAX = (1n << 256n) - 1n

// ---- valid results -----------------------------------------------------------

test('accepts a minimal even-length quantity: 0x01 -> 1 wei', () => {
  assert.equal(priceWeiOf(parsePriceResult(envelope('0x01'))), 1n)
})

test('accepts a realistic 32-byte price word with leading zeros', () => {
  assert.equal(priceWeiOf(parsePriceResult(envelope(word(TWO_ETH_WEI)))), TWO_ETH_WEI)
})

test('accepts the maximum uint256', () => {
  assert.equal(priceWeiOf(parsePriceResult(envelope(word(UINT256_MAX)))), UINT256_MAX)
})

test('accepts uppercase hex digits and short leading-zero encodings', () => {
  assert.equal(priceWeiOf(parsePriceResult(envelope('0x0064'))), 100n)
  assert.equal(priceWeiOf(parsePriceResult(envelope('0x0064AB'))), 0x64abn)
})

test('tolerates extra JSON-RPC fields and a non-numeric id', () => {
  const res = parsePriceResult({ jsonrpc: '2.0', id: 'fake-id', extra: true, result: '0x01' })
  assert.equal(priceWeiOf(res), 1n)
})

test('requirePositive:false accepts a well-formed zero (diagnostics only)', () => {
  const res = parsePriceResult(envelope('0x00'), { requirePositive: false })
  assert.equal(priceWeiOf(res), 0n)
})

// ---- JSON-RPC level failures ---------------------------------------------------

test('rejects a JSON-RPC error object, surfacing code and message', () => {
  const res = parsePriceResult({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: 'execution reverted' },
  })
  assert.equal(codeOf(res), 'rpc_error')
  assert.match(res.ok ? '' : res.message, /-32000/)
  assert.match(res.ok ? '' : res.message, /execution reverted/)
})

test('rejects a JSON-RPC error object without code or message', () => {
  assert.equal(codeOf(parsePriceResult({ jsonrpc: '2.0', id: 1, error: {} })), 'rpc_error')
})

test('error wins when both error and result are present', () => {
  const res = parsePriceResult({
    jsonrpc: '2.0',
    id: 1,
    error: { code: 3, message: 'fake revert' },
    result: '0x01',
  })
  assert.equal(codeOf(res), 'rpc_error')
})

test('rejects a response body that is not an object', () => {
  for (const bad of ['nope', 42, null, true, ['0x01']]) {
    assert.equal(codeOf(parsePriceResult(bad)), 'invalid_response', 'payload: ' + String(bad))
  }
})

// ---- result shape failures -----------------------------------------------------

test('rejects a missing or null result', () => {
  assert.equal(codeOf(parsePriceResult({ jsonrpc: '2.0', id: 1 })), 'missing_result')
  assert.equal(codeOf(parsePriceResult(envelope(null))), 'missing_result')
  assert.equal(
    codeOf(parsePriceResult({ jsonrpc: '2.0', id: 1, result: undefined })),
    'missing_result',
  )
})

test('rejects non-string results (negative numbers included)', () => {
  for (const bad of [123, -5, true, { hex: '0x01' }, ['0x01']]) {
    assert.equal(
      codeOf(parsePriceResult(envelope(bad))),
      'invalid_result',
      'result: ' + JSON.stringify(bad),
    )
  }
})

test('rejects results without a literal lowercase 0x prefix', () => {
  assert.equal(codeOf(parsePriceResult(envelope('1f'))), 'invalid_result')
  assert.equal(codeOf(parsePriceResult(envelope('0X12'))), 'invalid_result')
})

test('rejects non-hex digits after the prefix', () => {
  assert.equal(codeOf(parsePriceResult(envelope('0xzz'))), 'invalid_result')
  assert.equal(codeOf(parsePriceResult(envelope('0x1g'))), 'invalid_result')
})

test('rejects empty data (0x) — nothing to decode', () => {
  assert.equal(codeOf(parsePriceResult(envelope('0x'))), 'invalid_result')
})

test('rejects odd-length hex (not whole bytes), including 0x0', () => {
  assert.equal(codeOf(parsePriceResult(envelope('0x0'))), 'invalid_result')
  assert.equal(codeOf(parsePriceResult(envelope('0x123'))), 'invalid_result')
})

test('rejects negative hex strings', () => {
  assert.equal(codeOf(parsePriceResult(envelope('-0x01'))), 'invalid_result')
  assert.equal(codeOf(parsePriceResult(envelope('-1'))), 'invalid_result')
})

test('rejects anything wider than 32 bytes', () => {
  assert.equal(codeOf(parsePriceResult(envelope('0x' + 'f'.repeat(66)))), 'price_overflow')
  assert.equal(codeOf(parsePriceResult(envelope('0x' + '01'.repeat(33)))), 'price_overflow')
})

// ---- domain rule: a contract price must be positive ----------------------------

test('rejects a well-formed zero price by default', () => {
  assert.equal(codeOf(parsePriceResult(envelope('0x00'))), 'zero_price')
  assert.equal(codeOf(parsePriceResult(envelope(word(0n)))), 'zero_price')
})
