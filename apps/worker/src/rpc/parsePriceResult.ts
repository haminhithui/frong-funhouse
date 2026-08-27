/**
 * Pure parser/validator for the JSON-RPC result of a FrongEntry `price()`
 * eth_call — the smallest isolated piece of the Cloudflare config path.
 *
 * Input is the ALREADY-PARSED JSON-RPC response body (`unknown`), never a
 * Response: there is no fetch, no viem, no process.env and no global state
 * in this module, so the next task can wrap it with the HTTP/JSON-RPC
 * transport without touching any of these rules.
 *
 * `price()` returns an unsigned uint256, so a healthy `result` is
 * ABI-encoded DATA: a `0x`-prefixed hex string of whole bytes (an even
 * number of hex digits) whose width fits in 32 bytes. The parser accepts
 * exactly that shape and fails closed on everything else:
 *
 *   - JSON-RPC `error` object present          -> `rpc_error`
 *   - `result` missing or null                 -> `missing_result`
 *   - non-string / non-hex / odd-length /
 *     empty / negative / wrong prefix          -> `invalid_result`
 *   - wider than 32 bytes (uint256)            -> `price_overflow`
 *   - zero (an entry price must be positive)   -> `zero_price`
 *   - response body that is not a JSON object  -> `invalid_response`
 *
 * Note that `0x0` is ODD-length data (malformed) and is rejected as
 * `invalid_result`; the well-formed zero encoding `0x00` is rejected as
 * `zero_price`. The parser never throws and never fabricates a value.
 */

/** `0x` + at least one hex digit; both letter cases are accepted. */
const HEX_DATA = /^0x[0-9a-fA-F]+$/

/** Max uint256 width in hex digits: 32 bytes = 64 nibbles. */
const UINT256_HEX_DIGITS = 64

/** Stable machine-readable failure codes for monitoring and the 503 route. */
export type RpcPriceErrorCode =
  /** The node answered with a JSON-RPC `error` object (e.g. a revert). */
  | 'rpc_error'
  /** The response body is not a JSON object at all. */
  | 'invalid_response'
  /** No `result` field (or explicitly null) — nothing to decode. */
  | 'missing_result'
  /** `result` is not even-length `0x`-prefixed hex data. */
  | 'invalid_result'
  /** `result` is wider than 32 bytes, so it can never be a uint256 price. */
  | 'price_overflow'
  /** `result` decodes to 0 wei; a contract entry price must be positive. */
  | 'zero_price'

export interface RpcPriceSuccess {
  ok: true
  /** Decoded entry price in wei; positive uint256 unless positivity is off. */
  priceWei: bigint
}

export interface RpcPriceFailure {
  ok: false
  code: RpcPriceErrorCode
  /** Human-readable detail; safe to log, never served as payment truth. */
  message: string
}

/** Structured result: `{ ok: true, priceWei } | { ok: false, code, ... }`. */
export type RpcPriceResult = RpcPriceSuccess | RpcPriceFailure

export interface ParsePriceResultOptions {
  /**
   * FrongEntry prices must be positive, so zero is rejected by default.
   * Set to false only for diagnostics that need the raw decoded value.
   */
  requirePositive?: boolean
}

function fail(code: RpcPriceErrorCode, message: string): RpcPriceResult {
  return { ok: false, code, message }
}

/** Short type name for log messages; never leaks full payloads. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

/** Quote a suspicious string for messages, truncating log floods. */
function quote(value: string): string {
  const short = value.length > 74 ? value.slice(0, 74) + '…' : value
  return JSON.stringify(short)
}

function describeRpcError(error: unknown): string {
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const e = error as Record<string, unknown>
    const code = typeof e.code === 'number' ? String(e.code) : 'unnamed code'
    const message =
      typeof e.message === 'string' && e.message.length > 0 ? e.message : 'unnamed error'
    return code + ' ' + message
  }
  return describe(error)
}

/**
 * Validate and decode the JSON-RPC response of `eth_call` for `price()`.
 * Pure and total: any input resolves to a typed result, never a throw.
 */
export function parsePriceResult(
  payload: unknown,
  options: ParsePriceResultOptions = {},
): RpcPriceResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return fail('invalid_response', 'JSON-RPC response must be an object, got ' + describe(payload))
  }
  const body = payload as Record<string, unknown>

  // JSON-RPC allows exactly one of `error` / `result`; an `error` wins so a
  // bogus `result` sitting next to it can never be served.
  const error = body.error
  if (error !== undefined && error !== null) {
    return fail('rpc_error', 'JSON-RPC error ' + describeRpcError(error))
  }

  const result = body.result
  if (result === undefined || result === null) {
    return fail('missing_result', 'JSON-RPC response has no result field')
  }
  if (typeof result !== 'string') {
    return fail('invalid_result', 'result must be a hex string, got ' + describe(result))
  }
  if (!HEX_DATA.test(result)) {
    return fail(
      'invalid_result',
      'result is not non-empty 0x-prefixed hex data: ' + quote(result),
    )
  }
  const digits = result.length - 2 // strip the literal '0x'
  if (digits % 2 !== 0) {
    return fail(
      'invalid_result',
      'result has an odd number of hex digits (not whole bytes): ' + quote(result),
    )
  }
  if (digits > UINT256_HEX_DIGITS) {
    // 64 hex digits already cover 2^256-1, so a wider value can never fit.
    return fail('price_overflow', 'result is ' + digits + ' hex digits, wider than uint256')
  }

  // Safe: the regex above guarantees BigInt can parse this exact string.
  const priceWei = BigInt(result)

  if (options.requirePositive !== false && priceWei === 0n) {
    return fail('zero_price', 'price() returned 0 wei; an entry price must be positive')
  }

  return { ok: true, priceWei }
}
