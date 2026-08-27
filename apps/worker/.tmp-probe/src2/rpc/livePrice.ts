/**
 * Live FrongEntry `price()` reader built on viem's HTTP transport.
 *
 * Scope: ONE read-only contract read (`eth_call` of `price()`) against the
 * configured ENTRY_ADDRESS through the configured RPC_URL at the configured
 * chain id — the exact values the validated worker config passes in. Nothing
 * is hardcoded and nothing is cached here.
 *
 * Fail-closed contract: the reader NEVER throws and NEVER fabricates a
 * price. Every failure (malformed source, transport error, timeout, RPC
 * error, revert, or a decoded result that is not a positive uint256) comes
 * back as a structured `{ ok: false, code, message, retryable }` result the
 * route can turn straight into a 503. There is no FEE_AMOUNT_WEI fallback
 * and no default price anywhere in this module.
 *
 * Testability: two injection seams and no network required —
 *   - `client`: swap the whole contract-call surface (pure unit tests), or
 *   - `fetchImpl`: swap only the HTTP layer while the real viem transport,
 *     request encoding, and result decoding still run.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  BaseError,
  HttpRequestError,
  TimeoutError,
  type Address,
  type Chain,
} from 'viem'

/**
 * The single FrongEntry view this slice needs. Mirrors the `price()` entry
 * in the Node server's ENTRY_ABI, which reads the same contract via viem.
 */
export const ENTRY_PRICE_ABI = parseAbi(['function price() view returns (uint256)'])

/**
 * Everything the reader needs, taken verbatim from the validated worker
 * config (loadWorkerConfig). Fields are re-validated here as defense in
 * depth — an unvalidated source is an error, never a guess.
 */
export interface LivePriceSource {
  /** Server-side JSON-RPC endpoint (exact RPC_URL from the environment). */
  rpcUrl: string
  /** EVM chain id the RPC serves (exact CHAIN_ID from the environment). */
  chainId: number
  /** FrongEntry contract address (exact ENTRY_ADDRESS from the environment). */
  entryAddress: string
}

/** Stable machine-readable failure codes for monitoring and the 503 route. */
export type LivePriceErrorCode =
  /** The passed source (address/chain/RPC URL) is malformed — never retry. */
  | 'invalid_source'
  /** Transport-level failure: network error, HTTP error status, timeout. */
  | 'rpc_unreachable'
  /** The `price()` call failed at the node: JSON-RPC error or revert. */
  | 'rpc_call_failed'
  /** The decoded result is not a positive uint256 — never serve it. */
  | 'invalid_price'

export interface LivePriceSuccess {
  ok: true
  /** LIVE on-chain entry price in wei. */
  priceWei: bigint
  /** The exact source that produced the read (lowercased address). */
  source: { rpcUrl: string; chainId: number; entryAddress: string }
}

export interface LivePriceFailure {
  ok: false
  code: LivePriceErrorCode
  /** Human-readable detail; safe to log, never served as payment truth. */
  message: string
  /** Whether retrying the same source could plausibly succeed. */
  retryable: boolean
}

/** Structured result: `{ ok: true, priceWei } | { ok: false, code, ... }`. */
export type LivePriceResult = LivePriceSuccess | LivePriceFailure

/**
 * Narrow contract-call seam. Production wraps a viem public client; tests
 * inject a deterministic fake — no network, no Workers runtime needed.
 */
export interface EntryPriceClient {
  readContract(args: {
    address: Address
    abi: typeof ENTRY_PRICE_ABI
    functionName: 'price'
  }): Promise<unknown>
}

/** Injectable fetch matching viem's `fetchFn` (http transport config). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface LivePriceReaderOptions {
  /** Injectable client seam (unit tests); default builds a viem public client. */
  client?: EntryPriceClient
  /** Injectable fetch for the viem http transport (transport-level tests). */
  fetchImpl?: FetchLike
  /** HTTP request timeout in ms; default 10s, mirroring the chain budget. */
  timeoutMs?: number
  /** viem transport retries; default 0 — one attempt, the route decides retries. */
  retryCount?: number
}

export interface LivePriceReader {
  /** Read the live entry price; ALWAYS resolves, never throws. */
  read(): Promise<LivePriceResult>
}

const DEFAULT_TIMEOUT_MS = 10_000

const HTTP_TIMEOUT = 'http request timed out'

/**
 * Minimal viem `Chain` descriptor for the configured chain id. viem requires
 * this shape to build a client, but `eth_call` puts only the id-derived
 * fields on the wire — the name/currency/rpcUrls entries below are unused
 * placeholders and are never sent anywhere.
 */
function chainFor(chainId: number): Chain {
  return {
    id: chainId,
    name: 'frong-chain-' + String(chainId),
    nativeCurrency: { name: 'unused', symbol: 'UNUSED', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  }
}

/** Build the production client: viem public client over HTTP transport. */
function viemClient(source: LivePriceSource, options: LivePriceReaderOptions): EntryPriceClient {
  const publicClient = createPublicClient({
    chain: chainFor(source.chainId),
    transport: http(source.rpcUrl, {
      fetchFn: options.fetchImpl,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retryCount: options.retryCount ?? 0,
    }),
  })
  return {
    readContract: (args) =>
      publicClient.readContract({
        address: args.address,
        abi: args.abi,
        functionName: args.functionName,
      }),
  }
}

/** Re-validate the source; returns every problem at once (never a guess). */
function sourceProblems(source: LivePriceSource): string[] {
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
  if (!Number.isInteger(source.chainId) || source.chainId <= 0) {
    problems.push('chainId must be a positive integer')
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(source.entryAddress) || /^0x0{40}$/i.test(source.entryAddress)) {
    problems.push('entryAddress must be a non-zero 20-byte hex address')
  }
  return problems
}

function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    const short = (error as { shortMessage?: string }).shortMessage
    return short && short.length > 0 ? short : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classify anything `readContract` throws. Transport failures (network,
 * HTTP status, timeout) are `rpc_unreachable`; node-side failures (JSON-RPC
 * error, revert) are `rpc_call_failed`. Both are retryable; neither ever
 * yields a price.
 */
function classifyRpcError(error: unknown): LivePriceFailure {
  const message = describeError(error)
  let cause: unknown = error
  while (cause) {
    if (cause instanceof HttpRequestError || cause instanceof TimeoutError) {
      const timedOut =
        cause instanceof TimeoutError || message.toLowerCase().includes(HTTP_TIMEOUT.slice(0, 14))
      return {
        ok: false,
        code: 'rpc_unreachable',
        message: timedOut ? message + ' (rpc timeout)' : message,
        retryable: true,
      }
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return { ok: false, code: 'rpc_call_failed', message, retryable: true }
}

function invalidPrice(message: string): LivePriceFailure {
  return { ok: false, code: 'invalid_price', message, retryable: false }
}

/**
 * Create the live-price reader bound to one validated source. Inject a
 * `client` (or just a `fetchImpl`) for tests; production uses the viem
 * HTTP transport against the exact rpcUrl/chainId passed in.
 */
export function createLivePriceReader(
  source: LivePriceSource,
  options: LivePriceReaderOptions = {},
): LivePriceReader {
  return {
    async read(): Promise<LivePriceResult> {
      const problems = sourceProblems(source)
      if (problems.length > 0) {
        return {
          ok: false,
          code: 'invalid_source',
          message: 'live price source invalid: ' + problems.join('; '),
          retryable: false,
        }
      }

      const client = options.client ?? viemClient(source, options)

      let raw: unknown
      try {
        raw = await client.readContract({
          address: source.entryAddress as Address,
          abi: ENTRY_PRICE_ABI,
          functionName: 'price',
        })
      } catch (error) {
        return classifyRpcError(error)
      }

      if (typeof raw !== 'bigint') {
        return invalidPrice(
          'price() decoded to ' + (raw === null ? 'null' : typeof raw) + ', expected a uint256 bigint',
        )
      }
      if (raw <= 0n) {
        return invalidPrice(
          'price() returned ' + raw.toString() + ' wei; an entry fee must be positive',
        )
      }

      return {
        ok: true,
        priceWei: raw,
        source: {
          rpcUrl: source.rpcUrl,
          chainId: source.chainId,
          entryAddress: source.entryAddress.toLowerCase(),
        },
      }
    },
  }
}
