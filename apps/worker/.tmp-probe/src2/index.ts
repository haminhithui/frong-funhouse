/// <reference types="@cloudflare/workers-types" />

/**
 * FRONG Catch Cloudflare Worker scaffold.
 *
 * Routes:
 *   GET /health     — small JSON payload (unchanged).
 *   GET /api/config — frontend game config with the LIVE on-chain entry price.
 *   anything else   — 404.
 *
 * /api/config is strictly validated and fail-closed: a missing/invalid
 * environment returns a 503 with the concrete problems, an RPC failure to
 * read the entry price returns a 503, and a stale FEE_AMOUNT_WEI is never
 * used as payment truth. Auth, payment, session, and mint routes are
 * intentionally absent and land in later tasks.
 */

import { loadWorkerConfig, type Env, type WorkerGameConfig } from './config'
import { createEntryPriceReader } from './chain/price'

interface HealthBody {
  ok: true
  service: string
}

interface ErrorBody {
  ok: false
  error: string
}

/** Frontend-compatible game config (src/paid/api.ts GameConfigResponse). */
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

const SERVICE_NAME = 'frong-catch-worker'

function jsonResponse(
  body: HealthBody | ErrorBody | ConfigBody | { ok: false; error: string; problems: string[] },
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

/** Injectable seams so tests never touch a real network. */
export interface WorkerDeps {
  /**
   * Live entry-price reader (wei). Production reads the chain through the
   * configured RPC via eth_call; tests inject a deterministic fake.
   */
  priceReader?: (config: WorkerGameConfig) => Promise<bigint>
}

function defaultPriceReader(config: WorkerGameConfig): Promise<bigint> {
  return createEntryPriceReader(config.rpcUrl).readPrice(config.entry)
}

export function createFetchHandler(deps: WorkerDeps = {}): ExportedHandler<Env> {
  const readPrice = deps.priceReader ?? defaultPriceReader
  return {
    async fetch(request, env, _ctx) {
      const { pathname } = new URL(request.url)

      if (request.method === 'GET' && pathname === '/health') {
        return jsonResponse({ ok: true, service: SERVICE_NAME }, 200)
      }

      if (request.method === 'GET' && pathname === '/api/config') {
        const result = loadWorkerConfig(env)
        if (!result.ok) {
          return jsonResponse(
            {
              ok: false,
              error: 'worker configuration invalid',
              problems: result.problems,
            },
            503,
            { 'cache-control': 'no-store' },
          )
        }

        const config = result.config
        let feeAmount: bigint
        try {
          // LIVE on-chain read; any failure fails the request — no fallback.
          feeAmount = await readPrice(config)
        } catch {
          return jsonResponse(
            { ok: false, error: 'could not read the on-chain price' },
            503,
            { 'cache-control': 'no-store' },
          )
        }
        if (feeAmount <= 0n) {
          return jsonResponse(
            { ok: false, error: 'could not read the on-chain price' },
            503,
            { 'cache-control': 'no-store' },
          )
        }

        const body: ConfigBody = {
          chainId: config.chainId,
          frong: config.frong,
          entry: config.entry,
          trophy: config.trophy,
          feeAmount: feeAmount.toString(),
          countdownTicks: config.countdownTicks,
          durationTicks: config.durationTicks,
          buildHash: config.buildHash,
        }
        return jsonResponse(body, 200, { 'cache-control': 'no-store' })
      }

      return jsonResponse({ ok: false, error: 'not_found' }, 404)
    },
  }
}

export default createFetchHandler()
