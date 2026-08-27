/**
 * Live FrongEntry price reader — a minimal, dependency-free JSON-RPC adapter.
 *
 * Scope: ONE read-only `eth_call` of `price()` on the configured entry
 * contract via the configured RPC_URL. No viem dependency is added for this
 * (the root install is an ancestor node_modules we must not rely on); the
 * call is a plain POST the Workers runtime can make with global `fetch`.
 *
 * Fail-closed contract: every failure mode (network error, timeout, non-200,
 * JSON-RPC error, malformed or overflowing result) throws EntryPriceError.
 * The route turns any throw into a 503 — it NEVER falls back to a stale
 * FEE_AMOUNT_WEI or any cached/default price.
 */

/** Thrown for every RPC/decoding failure; `reason` is a stable machine string. */
export class EntryPriceError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = 'EntryPriceError'
  }
}

/**
 * 4-byte selector for `price()` (the only FrongEntry view this slice needs):
 * keccak256("price()")[0..4] = 0xc69c4ec9. This matches the `price()`
 * entry in apps/server ENTRY_ABI, which the Node server reads through viem.
 */
export const PRICE_CALL_DATA = '0xc69c4ec9'

/** Minimal structural slice of `fetch` so tests can inject a fake. */
export type FetchLike = (
  input: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  },
) => Promise<Response>

export interface EntryPriceReader {
  /** Resolve the LIVE entry price in wei; ALWAYS throws on failure. */
  readPrice(entryAddress: string): Promise<bigint>
}

export interface PriceReaderOptions {
  /** Injectable for unit tests; defaults to the runtime's global fetch. */
  fetchImpl?: FetchLike
  /** Request timeout. Default 10s, mirroring the Node server's chain budget. */
  timeoutMs?: number
}

interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code?: number; message?: string }
}

function isHexQuantity(value: unknown): value is string {
  return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)
}

/** Create the live-price reader bound to one RPC endpoint. */
export function createEntryPriceReader(rpcUrl: string, options: PriceReaderOptions = {}): EntryPriceReader {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 10_000

  return {
    async readPrice(entryAddress: string): Promise<bigint> {
      let response: Response
      try {
        response = await doFetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [{ to: entryAddress, data: PRICE_CALL_DATA }, 'latest'],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw new EntryPriceError(
          'entry price RPC request failed: ' + String(error),
          'rpc_unreachable',
        )
      }

      if (!response.ok) {
        throw new EntryPriceError(
          'entry price RPC returned HTTP ' + String(response.status),
          'rpc_http_error',
        )
      }

      let payload: JsonRpcSuccess
      try {
        payload = (await response.json()) as JsonRpcSuccess
      } catch (error) {
        throw new EntryPriceError(
          'entry price RPC returned invalid JSON: ' + String(error),
          'rpc_invalid_response',
        )
      }

      if (payload.error) {
        throw new EntryPriceError(
          'entry price RPC error: ' + (payload.error.message ?? 'unnamed JSON-RPC error'),
          'rpc_call_error',
        )
      }

      const result = payload.result
      if (!isHexQuantity(result)) {
        throw new EntryPriceError(
          'entry price RPC returned a non-hex result',
          'rpc_invalid_result',
        )
      }
      if (result === '0x') {
        throw new EntryPriceError(
          'entry price RPC returned empty data (wrong contract or revert)',
          'rpc_empty_result',
        )
      }
      if (result.length > 66) {
        // uint256 is at most 32 bytes (0x + 64 nibbles); anything longer can
        // never be a valid price.
        throw new EntryPriceError(
          'entry price RPC result exceeds uint256',
          'rpc_overflow_result',
        )
      }

      return BigInt(result)
    },
  }
}
