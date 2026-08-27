/**
 * Worker-side environment validation for GET /api/config.
 *
 * Scope: strict, fail-closed validation of the wrangler vars needed to serve
 * the frontend game config. Missing or invalid configuration must surface a
 * clear 503 — the route NEVER fabricates a feeAmount, and it never falls back
 * to a stale FEE_AMOUNT_WEI (that var is not part of this contract at all;
 * the only payment truth is the live on-chain `price()` read).
 *
 * Environment separation (mirrors wrangler.json env blocks):
 *   staging    → testnet 46630
 *   production → mainnet 4663
 *   local/development → testnet 46630 or a local EVM (31337); never mainnet,
 *     so every mainnet RPC read is attributable to the production env.
 */

import type { D1DatabaseLike } from './auth/repo.ts'

/** Bindings declared per environment in wrangler.json (no secrets). */
export interface Env {
  /** Environment label; APP_ENV is canonical, ENVIRONMENT is the scaffold fallback. */
  APP_ENV?: string
  /** Legacy scaffold name for the environment label (see APP_ENV). */
  ENVIRONMENT?: string
  /** Network label, e.g. 'testnet' (staging) or 'mainnet' (production). */
  NETWORK?: string
  /** EVM chain id as a string, e.g. '46630' (testnet) or '4663' (mainnet). */
  CHAIN_ID?: string
  /** Server-side JSON-RPC endpoint used for the live entry-price read. */
  RPC_URL?: string
  /** FRONG token contract address. */
  FRONG_ADDRESS?: string
  /** FrongEntry (payment) contract address — the `price()` source of truth. */
  ENTRY_ADDRESS?: string
  /** Trophy (mint) contract address. */
  TROPHY_ADDRESS?: string
  /** Sim build hash pinned per deploy; the frontend contract requires 64 hex. */
  BUILD_HASH?: string
  /** Optional gameplay pacing; defaults match the Node server (180). */
  COUNTDOWN_TICKS?: string
  /** Optional gameplay pacing; defaults match the Node server (3600). */
  DURATION_TICKS?: string
  /**
   * Comma-separated allowlist of exact web origins allowed by CORS, e.g.
   * 'https://app.example.com,https://staging.app.example.com'. Empty/missing
   * means NO origin is allowed (fail-closed). Never a wildcard and never a
   * hardcoded production domain — this middleware only echoes an origin back
   * when it appears verbatim in this list.
   */
  CORS_ORIGINS?: string
  /**
   * D1 database binding (wrangler.json d1_databases binding name "DB") the
   * auth repository persists hashed challenges/tokens to. Declared as the
   * repository's structural D1 slice (src/auth/repo.ts): the real
   * D1Database satisfies it and unit tests inject an in-memory fake.
   * Optional on purpose — config validation never depends on bindings, and
   * routes that need durable auth state fail closed (503) when it is absent.
   */
  DB?: D1DatabaseLike
}

export type AppEnvironment = 'local' | 'development' | 'staging' | 'production'

/** Fully validated config; every field is trusted once loadWorkerConfig returns ok. */
export interface WorkerGameConfig {
  appEnv: AppEnvironment
  chainId: number
  network: string | null
  rpcUrl: string
  frong: string
  entry: string
  trophy: string
  buildHash: string
  countdownTicks: number
  durationTicks: number
}

export type ConfigResult =
  { ok: true; config: WorkerGameConfig } | { ok: false; problems: string[] }

const APP_ENVIRONMENTS: readonly AppEnvironment[] = [
  'local',
  'development',
  'staging',
  'production',
]

const CHAIN_IDS = [31337, 46630, 4663] as const
const TESTNET_CHAIN_ID = 46630
const MAINNET_CHAIN_ID = 4663

function envValue(env: Env, key: Exclude<keyof Env, 'DB'>): string | null {
  const value = env[key]?.trim()
  return value ? value : null
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
}

function validHttpUrl(value: string, httpsOnly = false, publicOnly = false): boolean {
  try {
    const url = new URL(value)
    if (httpsOnly && url.protocol !== 'https:') return false
    if (!httpsOnly && url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    return !publicOnly || !isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

function validEthereumAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)
}

function positiveIntProblem(
  env: Env,
  key: 'COUNTDOWN_TICKS' | 'DURATION_TICKS',
  fallback: number,
  minimumExclusive: boolean,
  problems: string[],
): number {
  const raw = envValue(env, key)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || (minimumExclusive && value === 0)) {
    problems.push(
      key + (minimumExclusive ? ' must be a positive integer' : ' must be a non-negative integer'),
    )
    return fallback
  }
  return value
}

/**
 * Validate the /api/config environment. Returns every problem at once so an
 * operator sees the full misconfiguration, never a piecemeal one.
 */
export function loadWorkerConfig(env: Env): ConfigResult {
  const problems: string[] = []

  const appEnvRaw = (envValue(env, 'APP_ENV') ?? envValue(env, 'ENVIRONMENT')) as AppEnvironment
  const appEnv = APP_ENVIRONMENTS.includes(appEnvRaw) ? appEnvRaw : null
  if (!appEnv) {
    problems.push('APP_ENV must be one of local, development, staging, or production')
  }

  const chainRaw = envValue(env, 'CHAIN_ID')
  const chainId = chainRaw === null ? Number.NaN : Number(chainRaw)
  if (!CHAIN_IDS.includes(chainId as (typeof CHAIN_IDS)[number])) {
    problems.push('CHAIN_ID must be one of 31337, 46630, or 4663')
  }

  const network = envValue(env, 'NETWORK')
  const realChain = chainId === TESTNET_CHAIN_ID || chainId === MAINNET_CHAIN_ID

  // Staging/testnet 46630 and production/mainnet 4663 separation.
  if (appEnv === 'staging' && chainId !== TESTNET_CHAIN_ID) {
    problems.push('APP_ENV staging requires CHAIN_ID 46630 (testnet)')
  }
  if (appEnv === 'production' && chainId !== MAINNET_CHAIN_ID) {
    problems.push('APP_ENV production requires CHAIN_ID 4663 (mainnet)')
  }
  if ((appEnv === 'local' || appEnv === 'development') && chainId === MAINNET_CHAIN_ID) {
    problems.push('APP_ENV ' + appEnv + ' cannot target mainnet 4663; use the production env')
  }
  if (network !== null && chainId === TESTNET_CHAIN_ID && network !== 'testnet') {
    problems.push('NETWORK must be testnet for CHAIN_ID 46630')
  }
  if (network !== null && chainId === MAINNET_CHAIN_ID && network !== 'mainnet') {
    problems.push('NETWORK must be mainnet for CHAIN_ID 4663')
  }

  const rpcUrl = envValue(env, 'RPC_URL') ?? ''
  if (!validHttpUrl(rpcUrl)) {
    problems.push('RPC_URL must be an http(s) URL')
  } else if (realChain) {
    // A real chain never reads a loopback or plain-http RPC: the URL must be
    // an explicitly pinned public https endpoint.
    if (!validHttpUrl(rpcUrl, true, true)) {
      problems.push('RPC_URL for a real chain must be a public https:// URL')
    }
  }

  for (const [key, label] of [
    ['FRONG_ADDRESS', 'FRONG_ADDRESS'],
    ['ENTRY_ADDRESS', 'ENTRY_ADDRESS'],
    ['TROPHY_ADDRESS', 'TROPHY_ADDRESS'],
  ] as const) {
    if (!validEthereumAddress(envValue(env, key) ?? '')) {
      problems.push(label + ' missing or invalid (set it in the environment vars for this env)')
    }
  }

  const buildHash = envValue(env, 'BUILD_HASH') ?? ''
  if (!/^[0-9a-f]{64}$/.test(buildHash)) {
    problems.push('BUILD_HASH must be the 64-hex sim build hash pinned for this deploy')
  }

  const countdownTicks = positiveIntProblem(env, 'COUNTDOWN_TICKS', 180, false, problems)
  const durationTicks = positiveIntProblem(env, 'DURATION_TICKS', 3600, true, problems)

  // appEnv === null always pushed a problem above; the guard is for the
  // compiler's narrowing only and never changes which branch runs.
  if (problems.length > 0 || !appEnv) return { ok: false, problems }

  return {
    ok: true,
    config: {
      appEnv,
      chainId,
      network,
      rpcUrl,
      frong: (envValue(env, 'FRONG_ADDRESS') ?? '').toLowerCase(),
      entry: (envValue(env, 'ENTRY_ADDRESS') ?? '').toLowerCase(),
      trophy: (envValue(env, 'TROPHY_ADDRESS') ?? '').toLowerCase(),
      buildHash,
      countdownTicks,
      durationTicks,
    },
  }
}
