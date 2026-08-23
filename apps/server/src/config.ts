import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ServerConfig {
  port: number
  /** Bind address. Production containers should use 0.0.0.0 behind TLS at the edge. */
  host?: string
  rpcUrl: string
  chainId: number
  frong: string
  entry: string
  trophy: string
  /** Private key of the team minter (hot key). Missing = minting disabled. */
  minterKey: string | null
  feeAmount: bigint
  sessionTtlMs: number
  authTtlMs: number
  confirmations: number
  countdownTicks: number
  durationTicks: number
  metadataBaseUrl: string
  dataDir: string
  /** Privy server verification (app id + secret + optional verification key). */
  privyAppId: string | null
  privyAppSecret: string | null
  privyVerificationKey: string | null
  /**
   * CORS allowlist (comma-separated CORS_ORIGINS). Empty = dev default:
   * no-Origin plus localhost/127.0.0.1 on ports 8080 and 4173.
   */
  corsOrigins: string[]
  /** Global in-memory rate limit: tokens refilled per minute (per client IP). */
  rateLimitPerMinute: number
  /** Global in-memory rate limit: burst capacity (per client IP). */
  rateLimitBurst: number
  /** Stricter per-IP rate limit for /api/challenge (tokens per minute). */
  challengeRatePerMinute: number
  /** Pinata pinner (PINATA_JWT + PINATA_GATEWAY). Empty JWT = local file pinner in dev only. */
  pinataJwt: string | null
  pinataGateway: string | null
  /** AWS KMS signer (KMS_REGION + KMS_KEY_ID + KMS_MINER_ADDRESS). */
  kmsRegion: string | null
  kmsKeyId: string | null
  kmsMinerAddress: string | null
  /** Separate operator credential for recovery actions; never a wallet auth token. */
  operatorToken: string | null
  /** Resolved NODE_ENV; optional for existing injected test configs. */
  runtimeEnvironment?: string
  /** Legacy compatibility flag; production now uses the durable Store adapter. */
  allowMemoryOnlyAuthSessions?: boolean
}

interface DeploymentRecord {
  chainId?: number
  frong?: string
  entry?: string
  trophy?: string
  price?: string
}

const DEFAULT_DEPLOYMENTS_DIR = join(__dirname, '..', '..', '..', 'contracts', 'deployments')

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim()
  return value ? value : null
}

function envBoolean(env: NodeJS.ProcessEnv, key: string): boolean {
  return ['1', 'true', 'yes'].includes((envValue(env, key) ?? '').toLowerCase())
}

function envBigInt(env: NodeJS.ProcessEnv, key: string, fallback: string): bigint {
  const raw = envValue(env, key) ?? fallback
  try {
    return BigInt(raw)
  } catch {
    // Keep boot in the normal configProblems path instead of throwing an
    // unclassified RangeError before fail-closed validation can report it.
    return -1n
  }
}

/** Mainnet is always production-like, even when NODE_ENV was omitted. */
export function isProductionLike(config: ServerConfig): boolean {
  return (
    config.chainId === 4663 ||
    config.runtimeEnvironment === 'production' ||
    process.env.NODE_ENV === 'production'
  )
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

/**
 * The deployment record for a chain: testnet 46630, mainnet 4663, or the
 * machine-specific localhost record. A real chain NEVER falls back to the
 * localhost record — pointing the server at local addresses while configured
 * for 46630 would silently break every payment validation.
 */
export function deploymentRecordPath(
  chainId: number,
  deploymentsDir = DEFAULT_DEPLOYMENTS_DIR,
): string {
  if (chainId === 46630) return join(deploymentsDir, 'testnet-46630.json')
  if (chainId === 4663) return join(deploymentsDir, 'mainnet-4663.json')
  return join(deploymentsDir, 'localhost.json')
}

/**
 * Config precedence: environment variables first (FRONG_ADDRESS,
 * ENTRY_ADDRESS, TROPHY_ADDRESS, FEE_AMOUNT_WEI, CHAIN_ID, RPC_URL), then the
 * chain-specific deployment record written by contracts/scripts. Official
 * testnet 46630 and mainnet 4663 RPC URLs are NEVER guessed: they are
 * env-only and must be pinned from official Robinhood Chain documentation.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  deploymentsDir = DEFAULT_DEPLOYMENTS_DIR,
): ServerConfig {
  const chainId = Number(env.CHAIN_ID ?? 31337)
  const recordPath = deploymentRecordPath(chainId, deploymentsDir)
  let record: DeploymentRecord = {}
  if (existsSync(recordPath)) {
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8')) as DeploymentRecord
    } catch {
      record = {}
    }
  }

  return {
    port: Number(env.PORT ?? 8787),
    host: envValue(env, 'HOST') ?? '127.0.0.1',
    rpcUrl: envValue(env, 'RPC_URL') ?? (chainId === 31337 ? 'http://127.0.0.1:8545' : ''),
    chainId,
    frong: envValue(env, 'FRONG_ADDRESS') ?? record.frong ?? '',
    entry: envValue(env, 'ENTRY_ADDRESS') ?? record.entry ?? '',
    trophy: envValue(env, 'TROPHY_ADDRESS') ?? record.trophy ?? '',
    minterKey: envValue(env, 'MINTER_KEY'),
    feeAmount: envBigInt(env, 'FEE_AMOUNT_WEI', record.price ?? '0'),
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 10 * 60 * 1000),
    authTtlMs: Number(env.AUTH_TTL_MS ?? 30 * 60 * 1000),
    confirmations: Number(env.CONFIRMATIONS ?? 1),
    countdownTicks: Number(env.COUNTDOWN_TICKS ?? 180),
    durationTicks: Number(env.DURATION_TICKS ?? 3600),
    metadataBaseUrl:
      envValue(env, 'METADATA_BASE_URL') ?? (chainId === 4663 ? '' : 'http://127.0.0.1:8787'),
    dataDir: resolve(envValue(env, 'DATA_DIR') ?? join(__dirname, '..', 'data')),
    privyAppId: envValue(env, 'PRIVY_APP_ID'),
    privyAppSecret: envValue(env, 'PRIVY_APP_SECRET'),
    privyVerificationKey: envValue(env, 'PRIVY_VERIFICATION_KEY'),
    corsOrigins: (envValue(env, 'CORS_ORIGINS') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MIN ?? 30),
    rateLimitBurst: Number(env.RATE_LIMIT_BURST ?? 60),
    challengeRatePerMinute: Number(env.CHALLENGE_RATE_PER_MIN ?? 10),
    pinataJwt: envValue(env, 'PINATA_JWT'),
    pinataGateway: envValue(env, 'PINATA_GATEWAY'),
    kmsRegion: envValue(env, 'KMS_REGION'),
    kmsKeyId: envValue(env, 'KMS_KEY_ID'),
    kmsMinerAddress: envValue(env, 'KMS_MINTER_ADDRESS'),
    operatorToken: envValue(env, 'OPERATOR_TOKEN'),
    runtimeEnvironment: envValue(env, 'NODE_ENV') ?? 'development',
    allowMemoryOnlyAuthSessions: envBoolean(env, 'ALLOW_MEMORY_ONLY_AUTH_SESSIONS'),
  }
}

export function configProblems(config: ServerConfig): string[] {
  const problems: string[] = []
  if (![31337, 46630, 4663].includes(config.chainId)) {
    problems.push('CHAIN_ID must be one of 31337, 46630, or 4663')
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    problems.push('PORT must be an integer between 1 and 65535')
  }
  if (!validHttpUrl(config.rpcUrl)) problems.push('RPC_URL must be an http(s) URL')
  if ([46630, 4663].includes(config.chainId) && isLoopbackUrl(config.rpcUrl)) {
    problems.push('RPC_URL for a real chain must be explicitly configured and cannot be loopback')
  }
  if ([46630, 4663].includes(config.chainId) && !validHttpUrl(config.rpcUrl, true, true)) {
    problems.push('RPC_URL for a real chain must be a public https:// URL')
  }
  if (!validEthereumAddress(config.frong)) {
    problems.push(
      'FRONG_ADDRESS missing or invalid — set it in the environment or run the deploy for chain ' +
        config.chainId +
        ' (contracts/deployments/' +
        (config.chainId === 46630
          ? 'testnet-46630'
          : config.chainId === 4663
            ? 'mainnet-4663'
            : 'localhost') +
        '.json)',
    )
  }
  if (!validEthereumAddress(config.entry)) {
    problems.push('ENTRY_ADDRESS missing or invalid (same sources as FRONG_ADDRESS)')
  }
  if (!validEthereumAddress(config.trophy)) {
    problems.push('TROPHY_ADDRESS missing or invalid (same sources as FRONG_ADDRESS)')
  }
  if (config.feeAmount <= 0n) problems.push('FEE_AMOUNT_WEI must be positive')
  if (config.feeAmount > 1_000_000n * 10n ** 18n) {
    problems.push('FEE_AMOUNT_WEI exceeds the FrongEntry maximum price')
  }

  if (!Number.isInteger(config.sessionTtlMs) || config.sessionTtlMs <= 0) {
    problems.push('SESSION_TTL_MS must be a positive integer')
  }
  if (!Number.isInteger(config.authTtlMs) || config.authTtlMs <= 0) {
    problems.push('AUTH_TTL_MS must be a positive integer')
  }
  if (!Number.isInteger(config.confirmations) || config.confirmations < 0) {
    problems.push('CONFIRMATIONS must be a non-negative integer')
  }
  if (!Number.isInteger(config.countdownTicks) || config.countdownTicks < 0) {
    problems.push('COUNTDOWN_TICKS must be a non-negative integer')
  }
  if (!Number.isInteger(config.durationTicks) || config.durationTicks <= 0) {
    problems.push('DURATION_TICKS must be a positive integer')
  }
  if (!Number.isInteger(config.rateLimitPerMinute) || config.rateLimitPerMinute <= 0) {
    problems.push('RATE_LIMIT_PER_MIN must be a positive integer')
  }
  if (!Number.isInteger(config.rateLimitBurst) || config.rateLimitBurst <= 0) {
    problems.push('RATE_LIMIT_BURST must be a positive integer')
  }
  if (!Number.isInteger(config.challengeRatePerMinute) || config.challengeRatePerMinute <= 0) {
    problems.push('CHALLENGE_RATE_PER_MIN must be a positive integer')
  }

  const kmsConfigured = [config.kmsRegion, config.kmsKeyId, config.kmsMinerAddress].filter(
    Boolean,
  ).length
  if (kmsConfigured > 0 && kmsConfigured < 3) {
    problems.push('KMS_REGION, KMS_KEY_ID, and KMS_MINTER_ADDRESS must be configured together')
  }
  if (config.kmsMinerAddress && !validEthereumAddress(config.kmsMinerAddress)) {
    problems.push('KMS_MINTER_ADDRESS must be a valid Ethereum address')
  }

  const productionLike = isProductionLike(config)
  if (config.pinataGateway && !validHttpUrl(config.pinataGateway, true, true)) {
    problems.push('PINATA_GATEWAY must be a public https:// URL')
  }
  for (const origin of config.corsOrigins) {
    if (
      origin === '*' ||
      !validHttpUrl(origin, productionLike, productionLike) ||
      new URL(origin).origin !== origin
    ) {
      problems.push('CORS_ORIGINS must contain exact http(s) origins without wildcards or paths')
      break
    }
  }
  if (productionLike) {
    if (!validHttpUrl(config.metadataBaseUrl, true, true)) {
      problems.push('METADATA_BASE_URL must be a public https:// URL in production')
    }
    if (!config.pinataJwt) problems.push('PINATA_JWT is required for production metadata pinning')
    if (!config.operatorToken || config.operatorToken.length < 32) {
      problems.push('OPERATOR_TOKEN must be a random secret of at least 32 characters')
    }
    if (config.corsOrigins.length === 0) {
      problems.push('CORS_ORIGINS must explicitly allow the production web origin')
    }
    if (kmsConfigured !== 3) {
      problems.push('production requires complete AWS KMS minter custody')
    }
    if (config.minterKey && config.chainId !== 4663) {
      problems.push('MINTER_KEY is not allowed in production; use KMS custody')
    }
  }
  if (config.chainId === 4663) {
    if (kmsConfigured !== 3) {
      problems.push('mainnet 4663 requires complete AWS KMS minter custody')
    }
    if (config.minterKey) {
      problems.push('MINTER_KEY is forbidden on mainnet 4663; use KMS custody')
    }
  }
  return problems
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname)
  } catch {
    return false
  }
}
