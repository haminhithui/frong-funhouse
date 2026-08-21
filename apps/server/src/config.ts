import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ServerConfig {
  port: number
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
  /** Pinata pinner (PINATA_JWT + PINATA_GATEWAY). Empty JWT = local file pinner. */
  pinataJwt: string | null
  pinataGateway: string | null
  /** AWS KMS signer (KMS_REGION + KMS_KEY_ID + KMS_MINER_ADDRESS). */
  kmsRegion: string | null
  kmsKeyId: string | null
  kmsMinerAddress: string | null
}

interface DeploymentRecord {
  chainId?: number
  frong?: string
  entry?: string
  trophy?: string
  price?: string
}

const DEFAULT_DEPLOYMENTS_DIR = join(__dirname, '..', '..', '..', 'contracts', 'deployments')

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
    rpcUrl: env.RPC_URL ?? 'http://127.0.0.1:8545',
    chainId,
    frong: env.FRONG_ADDRESS ?? record.frong ?? '',
    entry: env.ENTRY_ADDRESS ?? record.entry ?? '',
    trophy: env.TROPHY_ADDRESS ?? record.trophy ?? '',
    minterKey: env.MINTER_KEY ?? null,
    feeAmount: BigInt(env.FEE_AMOUNT_WEI ?? record.price ?? '0'),
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 10 * 60 * 1000),
    authTtlMs: Number(env.AUTH_TTL_MS ?? 30 * 60 * 1000),
    confirmations: Number(env.CONFIRMATIONS ?? 1),
    countdownTicks: Number(env.COUNTDOWN_TICKS ?? 180),
    durationTicks: Number(env.DURATION_TICKS ?? 3600),
    metadataBaseUrl: env.METADATA_BASE_URL ?? 'http://127.0.0.1:8787',
    dataDir: env.DATA_DIR ?? join(__dirname, '..', 'data'),
    privyAppId: env.PRIVY_APP_ID ?? null,
    privyAppSecret: env.PRIVY_APP_SECRET ?? null,
    privyVerificationKey: env.PRIVY_VERIFICATION_KEY ?? null,
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MIN ?? 30),
    rateLimitBurst: Number(env.RATE_LIMIT_BURST ?? 60),
    challengeRatePerMinute: Number(env.CHALLENGE_RATE_PER_MIN ?? 10),
    pinataJwt: env.PINATA_JWT ?? null,
    pinataGateway: env.PINATA_GATEWAY ?? null,
    kmsRegion: env.KMS_REGION ?? null,
    kmsKeyId: env.KMS_KEY_ID ?? null,
    kmsMinerAddress: env.KMS_MINER_ADDRESS ?? null,
  }
}

export function configProblems(config: ServerConfig): string[] {
  const problems: string[] = []
  if (![31337, 46630, 4663].includes(config.chainId)) {
    problems.push('CHAIN_ID must be one of 31337, 46630, or 4663')
  }
  if (!config.rpcUrl.startsWith('http')) problems.push('RPC_URL must be an http(s) URL')
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.frong)) {
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.entry)) {
    problems.push('ENTRY_ADDRESS missing or invalid (same sources as FRONG_ADDRESS)')
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.trophy)) {
    problems.push('TROPHY_ADDRESS missing or invalid (same sources as FRONG_ADDRESS)')
  }
  if (config.feeAmount <= 0n) problems.push('FEE_AMOUNT_WEI must be positive')
  return problems
}
