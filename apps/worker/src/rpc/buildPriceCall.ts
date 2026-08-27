/**
 * Pure JSON-RPC 2.0 request builder for the FrongEntry `price()` eth_call —
 * the smallest isolated piece of the RPC transport path.
 *
 * Input is the candidate ENTRY_ADDRESS (the exact value the validated worker
 * config would carry, re-validated here as defense in depth); output is the
 * POST body object for ONE read-only `eth_call`. There is no fetch, no
 * timeout, no AbortSignal, no URL, no viem, no process.env and no global
 * state in this module — the transport (rpc/fetchPrice.ts) stays the only
 * layer allowed to put this body on the wire.
 *
 * The fixed protocol values this module is allowed to carry:
 *   - JSON-RPC version `2.0`, request `id` 1 (one in-flight request per
 *     worker invocation), method `eth_call`, block tag `latest`
 *   - `data` = the 4-byte `price()` selector 0xc69c4ec9
 *     (keccak256("price()")[0..4]; the same constant as chain/price.ts
 *     PRICE_CALL_DATA and rpc/fetchPrice.ts PRICE_CALL_SELECTOR)
 *
 * Everything else — the address — must be passed in and is validated
 * STRICTLY BEFORE the body is built:
 *   - a string, lowercase `0x`-prefixed, exactly 40 hex digits (20 bytes)
 *   - the all-zero address is rejected (no contract can live there)
 *
 * Mixed-case hex digits are accepted and passed through verbatim; EIP-55
 * checksums are not recomputed here (a wrong checksum is the node's error
 * to report, not ours to guess).
 *
 * Fail-closed contract: the builder never throws and never fabricates a
 * body. A malformed address yields `{ ok: false, code: 'invalid_address' }`
 * and no request object is produced.
 */

/** 4-byte selector for the FrongEntry `price()` view — the one fixed constant. */
export const PRICE_CALL_SELECTOR = '0xc69c4ec9'

/** Lowercase `0x` + exactly 40 hex digits: a 20-byte EVM address. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** The all-zero address is never a valid FrongEntry deployment. */
const ZERO_ADDRESS = /^0x0{40}$/i

/** The `eth_call` transaction object this builder is allowed to assemble. */
export interface EthCallTarget {
  to: string
  data: string
}

/** The exact JSON-RPC 2.0 POST body for one `price()` eth_call. */
export interface PriceCallRequest {
  jsonrpc: '2.0'
  id: number
  method: 'eth_call'
  params: [EthCallTarget, 'latest']
}

export interface BuildPriceCallSuccess {
  ok: true
  body: PriceCallRequest
}

export interface BuildPriceCallFailure {
  ok: false
  code: 'invalid_address'
  /** Human-readable detail; safe to log, never served as payment truth. */
  message: string
}

/** Structured result: `{ ok: true, body } | { ok: false, code, message }`. */
export type BuildPriceCallResult = BuildPriceCallSuccess | BuildPriceCallFailure

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

/**
 * Build the JSON-RPC 2.0 POST body for one `eth_call` of FrongEntry
 * `price()` at the `latest` block. Pure and total: any input resolves to a
 * typed result, never a throw, and a fresh body object is allocated per
 * call, so callers may mutate a returned body without cross-talk.
 */
export function buildPriceCallRequest(entryAddress: unknown): BuildPriceCallResult {
  if (typeof entryAddress !== 'string') {
    return {
      ok: false,
      code: 'invalid_address',
      message: 'entryAddress must be a hex string, got ' + describe(entryAddress),
    }
  }
  if (!ADDRESS.test(entryAddress)) {
    return {
      ok: false,
      code: 'invalid_address',
      message: 'entryAddress must be a 0x-prefixed 20-byte hex address: ' + quote(entryAddress),
    }
  }
  if (ZERO_ADDRESS.test(entryAddress)) {
    return {
      ok: false,
      code: 'invalid_address',
      message: 'entryAddress must not be the all-zero address: ' + quote(entryAddress),
    }
  }

  return {
    ok: true,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: entryAddress, data: PRICE_CALL_SELECTOR }, 'latest'],
    },
  }
}
