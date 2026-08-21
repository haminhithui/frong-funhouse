import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerConfig } from '../src/config'

/** Minimal test config; every field is a typed config slot, nothing is guessed. */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    rpcUrl: 'http://127.0.0.1:8545',
    chainId: 31337,
    frong: '0x' + '11'.repeat(20),
    entry: '0x' + '22'.repeat(20),
    trophy: '0x' + '33'.repeat(20),
    minterKey: null,
    feeAmount: 10n * 10n ** 18n,
    sessionTtlMs: 10 * 60 * 1000,
    authTtlMs: 30 * 60 * 1000,
    confirmations: 1,
    countdownTicks: 1,
    durationTicks: 60,
    metadataBaseUrl: 'http://127.0.0.1:8787',
    dataDir: join(tmpdir(), 'frong-server-test-' + randomBytes(8).toString('hex')),
    privyAppId: null,
    privyAppSecret: null,
    privyVerificationKey: null,
    corsOrigins: [],
    rateLimitPerMinute: 30,
    rateLimitBurst: 60,
    challengeRatePerMinute: 10,
    pinataJwt: null,
    pinataGateway: null,
    kmsRegion: null,
    kmsKeyId: null,
    kmsMinerAddress: null,
    ...overrides,
  }
}
