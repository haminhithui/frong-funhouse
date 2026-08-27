/**
 * FRONG Catch Cloudflare Worker: GET /health, GET /api/config,
 * POST /api/challenge, 404 otherwise.
 *
 * GET /api/config is the first real route: it validates the environment with
 * loadWorkerConfig (strict, fail-closed) and then reads the LIVE on-chain
 * entry price through the fetch-based transport (createPriceFetcher /
 * fetchPrice) — one `eth_call` of `price()` on the configured ENTRY_ADDRESS
 * via the configured RPC_URL. Nothing but the `price()` selector is fixed;
 * the RPC URL and contract addresses always come from the typed, validated
 * environment.
 *
 * Fail-closed contract: a missing/invalid environment returns a structured
 * 503 with the concrete problems (and never reaches the network), and any
 * RPC failure — unreachable node, timeout, JSON-RPC error, malformed or
 * non-positive result, or an unexpected throw — returns a structured 503
 * carrying the transport's stable failure code. A stale FEE_AMOUNT_WEI (or
 * any cached/default price) is NEVER used as payment truth; the only fee
 * the route can serve is the value read live during this request. Health
 * stays a plain 200 and every other route/method stays a 404.
 *
 * POST /api/challenge is the first durable auth route (challenge issuance
 * ONLY — no verification, Privy, payment, session, or mint). It accepts the
 * frontend body shape {address}, validates it (lowercased 0x address), then
 * validates the configured chain with the same strict loadWorkerConfig the
 * config route uses. Persistence goes through the existing auth repository
 * (createAuthRepo(env.DB).issueChallenge): a fresh 128-bit nonce from the
 * Workers CSPRNG is returned RAW to the client while ONLY its SHA-256
 * digest plus challenge metadata (player, pending status, created/expires
 * stamps — expires_at = issuedAt + 5 min) is ever stored. A missing DB
 * binding, an invalid environment, or any repository failure fails closed
 * with a structured status; nothing about the store leaks.
 *
 * CORS (exact-origin, fail-closed): Env.CORS_ORIGINS is the ONLY source of
 * allowed origins — a comma-separated allowlist of absolute http(s) origins,
 * with no wildcard, no 'null', and no fallback. An Origin header is echoed
 * back as Access-Control-Allow-Origin only when it matches an allowlist
 * entry EXACTLY; every other Origin (and every request without one) gets no
 * allow-origin header at all. Preflight is an OPTIONS request carrying
 * Access-Control-Request-Method: it is answered 204 straight from the
 * middleware — before any routing, config load, or RPC fetch — and never
 * reaches the price transport. Bare OPTIONS without the preflight marker
 * keeps falling through to the existing 404. Access-Control-Allow-Credentials
 * is intentionally NEVER set: this worker has no cookie/session surface, and
 * the Authorization header is already covered by the preflight allowlist, so
 * credential mode is never opted into.
 */

// '.ts' specifiers so Node's native type stripping (node --test, no bundler)
// can resolve these exact relative imports — same convention as rpc/fetchPrice.ts.
import { loadWorkerConfig, type Env, type WorkerGameConfig } from './config.ts'
import { createPriceFetcher, type FetchLike } from './rpc/fetchPrice.ts'
import { createAuthRepo } from './auth/repo.ts'
import { issueWalletChallenge, parseChallengeAddress } from './auth/challenge.ts'

interface HealthBody {
  ok: true
  service: string
}

interface ErrorBody {
  ok: false
  error: string
}

/** Structured 503 body when the environment cannot produce a safe config. */
interface ConfigInvalidBody {
  ok: false
  error: string
  problems: string[]
}

/**
 * Structured 503 body when the live price read fails. Only the transport's
 * stable machine code is served; the human-readable transport message is
 * log-safe detail, never payment truth.
 */
interface PriceUnavailableBody {
  ok: false
  error: string
  code: string
}

/** Frontend-compatible game config (GameConfigResponse contract). */
interface ConfigBody {
  chainId: number
  frong: string
  entry: string
  trophy: string
  /** LIVE on-chain FrongEntry price in wei — never a stale/env value. */
  feeAmount: string
  countdownTicks: number
  durationTicks: number
  buildHash: string
}

/**
 * Frontend-compatible challenge issuance body — exactly the three fields
 * the client signs against (the Node server's /api/challenge contract).
 * The nonce is raw and client-visible; it is NEVER persisted anywhere.
 */
interface ChallengeBody {
  nonce: string
  message: string
  issuedAt: string
}

const SERVICE_NAME = 'frong-catch-worker'

// ---- CORS (exact-origin, fail-closed) -------------------------------------------

/**
 * Methods a cross-origin caller may use. Advertising a method changes no
 * server behavior (unknown routes/methods still 404 below); the browser is
 * simply told the worker's real surface. OPTIONS is listed because preflight
 * itself is a method the caller must be allowed to issue.
 */
const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS'

/** Request headers a cross-origin caller may send (case-insensitive). */
const CORS_ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'content-type',
])

/** How long a browser may cache a successful preflight. */
const CORS_MAX_AGE = '86400'

/**
 * Parse Env.CORS_ORIGINS into normalized exact origins. Each comma-separated
 * entry must be an absolute http(s) origin — scheme + host (+ optional port),
 * no path, query, fragment, or userinfo; anything else is DROPPED, never
 * guessed. Default ports are normalized away by the URL parser, so
 * 'https://a.example:443' allowlists 'https://a.example'. An unset/blank var
 * yields an empty set: no origin is ever allowed.
 */
function allowedCorsOrigins(env: Env): ReadonlySet<string> {
  const raw = env.CORS_ORIGINS?.trim()
  if (!raw) return new Set<string>()
  const origins = new Set<string>()
  for (const entry of raw.split(',')) {
    const value = entry.trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
      if (url.username || url.password) continue
      if (url.pathname !== '/' || url.search || url.hash) continue
      origins.add(url.origin)
    } catch {
      // Invalid entry: drop it rather than widening the allowlist.
    }
  }
  return origins
}

/**
 * Resolve the CORS decision for one request: the Origin is allowed only on an
 * EXACT match against the allowlist. '*' and 'null' can never match because
 * they are not valid absolute origins and so can never be allowlisted.
 */
function allowedOriginFor(request: Request, allowed: ReadonlySet<string>): string | null {
  const origin = request.headers.get('origin')
  if (origin === null || !allowed.has(origin)) return null
  return origin
}

/**
 * Headers shared by every response (actual and preflight): `Vary: Origin` so
 * no shared cache ever serves one origin's permissive response to another,
 * plus the echoed allow-origin when — and only when — the origin is allowed.
 */
function sharedCorsHeaders(allowedOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Origin' }
  if (allowedOrigin !== null) headers['access-control-allow-origin'] = allowedOrigin
  return headers
}

/**
 * Preflight response headers. For a disallowed origin nothing but
 * `Vary: Origin` is emitted — the browser fails the preflight closed and no
 * method/header surface is advertised to unapproved origins. For an allowed
 * origin, allow-methods/allow-headers are emitted only when the requested
 * method/headers fit the fixed allowlists — a request asking for anything
 * outside them gets no such header, so the browser (not this worker) fails
 * the preflight closed. Never allow-credentials: this worker has no
 * cookie/session surface to expose.
 */
function preflightHeaders(allowedOrigin: string | null, request: Request): Record<string, string> {
  const headers = sharedCorsHeaders(allowedOrigin)
  if (allowedOrigin === null) return headers

  const requestedMethod = request.headers.get('access-control-request-method')
  if (
    requestedMethod !== null &&
    CORS_ALLOW_METHODS.split(', ').includes(requestedMethod.toUpperCase())
  ) {
    headers['access-control-allow-methods'] = CORS_ALLOW_METHODS
  }

  const requestedHeaders = request.headers.get('access-control-request-headers')
  if (requestedHeaders !== null) {
    const names = requestedHeaders
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0)
    const everyHeaderAllowed =
      names.length > 0 && names.every((name) => CORS_ALLOWED_REQUEST_HEADERS.has(name))
    if (everyHeaderAllowed) headers['access-control-allow-headers'] = names.join(', ')
  }

  headers['access-control-max-age'] = CORS_MAX_AGE
  return headers
}

function jsonResponse(
  body: HealthBody | ErrorBody | ConfigInvalidBody | PriceUnavailableBody | ConfigBody | ChallengeBody,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

/**
 * Injectable seams so tests never touch a real network: `fetchImpl` swaps
 * the whole HTTP layer while the REAL createPriceFetcher transport (request
 * building, timeout, response parsing, failure classification) still runs.
 */
export interface WorkerDeps {
  fetchImpl?: FetchLike
}

/** Read the live entry price for a validated config; structured, never throws. */
async function readLivePrice(
  config: WorkerGameConfig,
  fetchImpl: FetchLike | undefined,
): Promise<{ priceWei: bigint } | { code: string }> {
  try {
    const result = await createPriceFetcher(
      { rpcUrl: config.rpcUrl, entryAddress: config.entry },
      fetchImpl ? { fetchImpl } : {},
    ).fetchPrice()
    if (!result.ok) return { code: result.code }
    return { priceWei: result.priceWei }
  } catch {
    // Defense in depth: the transport promises to resolve, but the route
    // stays fail-closed even if that promise is ever broken.
    return { code: 'rpc_unreachable' }
  }
}

/**
 * The fetch-handler surface this worker needs, declared locally so this file
 * typechecks in both programs that include it: the Workers build (globals
 * from @cloudflare/workers-types via tsconfig.json) and the Node test run
 * (globals from @types/node — same fetch-standard shapes). Structurally
 * compatible with ExportedHandler<Env>; wrangler only needs the default
 * export to expose a fetch method.
 */
export interface FetchHandler {
  fetch(request: Request, env: Env, ctx?: unknown): Promise<Response>
}

export function createFetchHandler(deps: WorkerDeps = {}): FetchHandler {
  return {
    async fetch(request, env, _ctx) {
      const { pathname } = new URL(request.url)
      const allowedOrigin = allowedOriginFor(request, allowedCorsOrigins(env))

      // Preflight (OPTIONS + Access-Control-Request-Method): answered by the
      // middleware alone — no routing, no config load, no RPC fetch, no body.
      // Bare OPTIONS without the preflight marker falls through to the 404
      // below, preserving the pre-CORS behavior.
      if (
        request.method === 'OPTIONS' &&
        request.headers.has('access-control-request-method')
      ) {
        return new Response(null, {
          status: 204,
          headers: preflightHeaders(allowedOrigin, request),
        })
      }

      // Shared CORS headers ride along on every actual response.
      const cors = sharedCorsHeaders(allowedOrigin)

      if (request.method === 'GET' && pathname === '/health') {
        return jsonResponse({ ok: true, service: SERVICE_NAME }, 200, cors)
      }

      if (request.method === 'GET' && pathname === '/api/config') {
        const result = loadWorkerConfig(env)
        if (!result.ok) {
          return jsonResponse(
            { ok: false, error: 'worker configuration invalid', problems: result.problems },
            503,
            { 'cache-control': 'no-store', ...cors },
          )
        }
        const config = result.config

        const price = await readLivePrice(config, deps.fetchImpl)
        if (!('priceWei' in price)) {
          return jsonResponse(
            { ok: false, error: 'could not read the on-chain price', code: price.code },
            503,
            { 'cache-control': 'no-store', ...cors },
          )
        }

        const body: ConfigBody = {
          chainId: config.chainId,
          frong: config.frong,
          entry: config.entry,
          trophy: config.trophy,
          feeAmount: price.priceWei.toString(),
          countdownTicks: config.countdownTicks,
          durationTicks: config.durationTicks,
          buildHash: config.buildHash,
        }
        return jsonResponse(body, 200, { 'cache-control': 'no-store', ...cors })
      }

      // POST /api/challenge — durable challenge issuance ONLY (no verify,
      // Privy, payment, session, or mint). Body first: the {address} shape
      // is validated (and lowercased) without touching config or D1, so a
      // malformed body is a plain 400 that never depends on store state.
      if (request.method === 'POST' && pathname === '/api/challenge') {
        let parsed: unknown
        try {
          parsed = await request.json()
        } catch {
          parsed = null
        }
        const player = parseChallengeAddress(parsed)
        if (player === null) {
          return jsonResponse(
            { ok: false, error: 'valid wallet address required' },
            400,
            { 'cache-control': 'no-store', ...cors },
          )
        }

        // The challenge's Chain ID line is the worker's CONFIGURED chain,
        // validated strict and fail-closed exactly like /api/config — a
        // challenge is never minted against an unvalidated environment.
        const result = loadWorkerConfig(env)
        if (!result.ok) {
          return jsonResponse(
            { ok: false, error: 'worker configuration invalid', problems: result.problems },
            503,
            { 'cache-control': 'no-store', ...cors },
          )
        }

        const db = env.DB
        if (!db) {
          return jsonResponse(
            { ok: false, error: 'auth store unavailable' },
            503,
            { 'cache-control': 'no-store', ...cors },
          )
        }

        // issueWalletChallenge persists ONLY sha256(nonce) + metadata via
        // the existing auth repository; any store failure fails closed
        // without echoing store detail to the client.
        try {
          const challenge = await issueWalletChallenge(createAuthRepo(db), {
            address: player,
            chainId: result.config.chainId,
          })
          const body: ChallengeBody = {
            nonce: challenge.nonce,
            message: challenge.message,
            issuedAt: challenge.issuedAt,
          }
          return jsonResponse(body, 200, { 'cache-control': 'no-store', ...cors })
        } catch {
          return jsonResponse(
            { ok: false, error: 'could not issue challenge' },
            500,
            { 'cache-control': 'no-store', ...cors },
          )
        }
      }

      return jsonResponse({ ok: false, error: 'not_found' }, 404, cors)
    },
  }
}

export default createFetchHandler()
