/**
 * Fetch-based JSON-RPC transport for the FrongEntry `price()` read — the
 * fetch-native sibling of rpc/livePrice.ts (viem) and chain/price.ts
 * (throwing adapter): native fetch, structured results, parser delegation.
 *
 * Scope: ONE read-only `eth_call` — `to` = the configured ENTRY_ADDRESS,
 * `data` = the 4-byte `price()` selector — POSTed as JSON-RPC 2.0 to the
 * configured RPC_URL at the `latest` block. Nothing is hardcoded beyond the
 * selector constant, the single fixed protocol value this slice is allowed
 * to carry: the URL and the address always come from the caller (mirroring
 * the validated worker config) and are re-validated here as defense in
 * depth. There is no route integration in this slice.
 *
 * Fail-closed contract: the transport NEVER throws and NEVER fabricates a
 * price. Every failure — malformed source, network error, non-2xx HTTP,
 * timeout, malformed JSON, JSON-RPC error, or a `result` that is not a
 * positive uint256 — comes back as a structured
 * `{ ok: false, code, message, retryable }` result. Response validation is
 * NOT reimplemented here: any 2xx body is handed to the pure
 * parsePriceResult() and its codes pass through untouched. There is no
 * FEE_AMOUNT_WEI fallback, no default price, and no cache.
 *
 * Testability: `fetchImpl` swaps the whole HTTP layer (deterministic fakes,
 * no network, no Workers runtime) and `timeoutMs` drives the AbortSignal
 * that is passed to every fetch call.
 */

import { parsePriceResult, type RpcPriceErrorCode } from './parsePriceResult'

/**
 * 4-byte selector for the FrongEntry `price()` view — the ONLY fixed
 * protocol value in this module. Same constant as chain/price.ts
 * (PRICE_CALL_DATA), so both transports put identical calldata on the wire.
 */
export const PRICE_CALL_SELECTOR = '0xc69c4ec9'

/** Default HTTP budget in ms, mirroring the chain budget used elsewhere. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Everything the transport needs, taken verbatim from the validated worker
 * config (loadWorkerConfig). Fields are re-validated on every call — an
 * unvalidated source is an error, never a guess.
 */
export interface PriceRpcSource {
  /** Server-side JSON-RPC endpoint (exact RPC_URL from the environment). */
  rpcUrl: string
  /** FrongEntry contract address (exact ENTRY_ADDRESS from the environment). */
  entryAddress: string
}

/** Injectable fetch slice: enough shape for one JSON-RPC POST. */
export type FetchLike = (
  input: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<Response>

export interface PriceFetcherOptions {
  /** Injectable fetch for unit tests; defaults to the runtime's global fetch. */
  fetchImpl?: FetchLike
  /**
   * HTTP request timeout in ms (drives the AbortSignal handed to fetch);
   * default 10s. Must be a positive integer when provided.
   */
  timeoutMs?: number
}

export interface PriceFetcher {
  /** Read the live entry price; ALWAYS resolves, never throws. */
  fetchPrice(): Promise<PriceRpcResult>
}

/** Stable machine-readable failure codes for monitoring and the 503 route. */
export type PriceRpcErrorCode =
  /** The passed source (RPC URL / address / timeout) is malformed — never retry. */
  | 'invalid_source'
  /** Transport failure: network error or a non-2xx HTTP status. */
  | 'rpc_unreachable'
  /** The request was aborted by the timeout AbortSignal. */
  | 'rpc_timeout'
  /** A 2xx body that is not JSON at all. */
  | 'malformed_json'
  /** Parser codes (rpc_error, invalid_response, missing_result, invalid_result,
   *  price_overflow, zero_price) — passed through from parsePriceResult. */
  | RpcPriceErrorCode

export interface PriceRpcSuccess {
  ok: true
  /** LIVE on-chain entry price in wei (positive uint256). */
  priceWei: bigint
}

export interface PriceRpcFailure {
  ok: false
  code: PriceRpcErrorCode
  /** Human-readable detail; safe to log, never served as payment truth. */
  message: string
  /** Whether retrying the same source could plausibly succeed. */
  retryable: boolean
}

/** Structured result: `{ ok: true, priceWei } | { ok: false, code, ... }`. */
export type PriceRpcResult = PriceRpcSuccess | PriceRpcFailure

/** Re-validate the source; collects every problem at once (never a guess). */
function sourceProblems(source: PriceRpcSource): string[] {
  const problems: string[] = []
  try {
    const url = new URL(source.rpcUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push('rpcUrl must be an http(s) URL')
    }
    if (url.username || url.password) problems.push('rpcUrl must not embed credentials')
  } catch {
    problems.push('rpcUrl must be an absolute http(s) URL')
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(source.entryAddress) || /^0x0{40}$/i.test(source.entryAddress)) {
    problems.push('entryAddress must be a non-zero 20-byte hex address')
  }
  return problems
}

function fail(code: PriceRpcErrorCode, message: string, retryable: boolean): PriceRpcFailure {
  return { ok: false, code, message, retryable }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the fetch-based price transport bound to one source. Inject a
 * `fetchImpl` (and optionally `timeoutMs`) for tests; production uses the
 * runtime's global fetch against the exact rpcUrl/entryAddress passed in.
 */
export function createPriceFetcher(
  source: PriceRpcSource,
  options: PriceFetcherOptions = {},
): PriceFetcher {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init))

  return {
    async fetchPrice(): Promise<PriceRpcResult> {
      const problems = sourceProblems(source)
      if (
        options.timeoutMs !== undefined &&
        (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
      ) {
        problems.push('timeoutMs must be a positive integer')
      }
      if (problems.length > 0) {
        return fail('invalid_source', 'price RPC source invalid: ' + problems.join('; '), false)
      }

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      // Only this transport can abort the signal, so `signal.aborted` in a
      // catch block unambiguously means "our timeout fired".
      const signal = AbortSignal.timeout(timeoutMs)

      let response: Response
      try {
        response = await doFetch(source.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [{ to: source.entryAddress, data: PRICE_CALL_SELECTOR }, 'latest'],
          }),
          signal,
        })
      } catch (error) {
        if (signal.aborted) {
          return fail('rpc_timeout', 'price RPC timed out after ' + String(timeoutMs) + 'ms', true)
        }
        return fail('rpc_unreachable', 'price RPC request failed: ' + describeError(error), true)
      }

      if (!response.ok) {
        return fail('rpc_unreachable', 'price RPC returned HTTP ' + String(response.status), true)
      }

      let text: string
      try {
        text = await response.text()
      } catch (error) {
        return fail('rpc_unreachable', 'price RPC body read failed: ' + describeError(error), true)
      }

      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch (error) {
        return fail(
          'malformed_json',
          'price RPC returned invalid JSON: ' + describeError(error),
          false,
        )
      }

      // Response validation is fully delegated to the pure parser; its
      // codes and messages pass through untouched. Only a node-side
      // JSON-RPC error is plausibly transient (rate limits), so it is the
      // one delegated code marked retryable.
      const parsed = parsePriceResult(payload)
      if (parsed.ok) return parsed
      return {
        ok: false,
        code: parsed.code,
        message: parsed.message,
        retryable: parsed.code === 'rpc_error',
      }
    },
  }
}
