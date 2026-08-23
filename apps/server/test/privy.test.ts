import { describe, expect, it } from 'vitest'
import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { createPrivyVerifier } from '../src/privy'
import type { ServerConfig } from '../src/config'

const APP_ID = 'test-privy-app'
const WALLET = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
const OTHER = '0x' + '44'.repeat(20)

function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 8787,
    rpcUrl: 'http://127.0.0.1:8545',
    chainId: 31337,
    frong: '0x' + '11'.repeat(20),
    entry: '0x' + '22'.repeat(20),
    trophy: '0x' + '33'.repeat(20),
    minterKey: null,
    feeAmount: 1n,
    sessionTtlMs: 600000,
    authTtlMs: 1800000,
    confirmations: 1,
    countdownTicks: 180,
    durationTicks: 3600,
    metadataBaseUrl: '',
    dataDir: '',
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
    operatorToken: null,
    ...overrides,
  }
}

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

interface TokenOverrides {
  audience?: string
  subject?: string
  linkedAccounts?: unknown[]
}

/** The ACCESS token: session claims only — no linked accounts. */
async function signAccessToken(
  privateKey: SigningKey,
  overrides: TokenOverrides = {},
): Promise<string> {
  return await new SignJWT({ sid: 'session-1' })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuer('privy.io')
    .setAudience(overrides.audience ?? APP_ID)
    .setSubject(overrides.subject ?? 'did:privy:user-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

/** The IDENTITY token: carries the linked_accounts claim like Privy's ID token. */
async function signIdToken(
  privateKey: SigningKey,
  overrides: TokenOverrides = {},
): Promise<string> {
  const linkedAccounts = overrides.linkedAccounts ?? [
    {
      type: 'wallet',
      id: 'w-1',
      address: WALLET,
      chain_type: 'ethereum',
      wallet_client_type: 'privy',
      lv: Math.floor(Date.now() / 1000),
    },
  ]
  return await new SignJWT({ sid: 'session-1', linked_accounts: JSON.stringify(linkedAccounts) })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuer('privy.io')
    .setAudience(overrides.audience ?? APP_ID)
    .setSubject(overrides.subject ?? 'did:privy:user-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

describe('createPrivyVerifier — key-only local verification (no app secret)', () => {
  it('builds a verifier from app id + public verification key without a secret', async () => {
    const { publicKey } = await generateKeyPair('ES256')
    const verifier = createPrivyVerifier(
      baseConfig({ privyAppId: APP_ID, privyVerificationKey: await exportSPKI(publicKey) }),
    )
    expect(verifier).not.toBeNull()
  })

  it('verifies a real two-token request: access token + identity token, wallet linked', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const verifier = createPrivyVerifier(
      baseConfig({ privyAppId: APP_ID, privyVerificationKey: await exportSPKI(publicKey) }),
    )
    if (!verifier) throw new Error('verifier missing')
    const result = await verifier.verify(
      WALLET,
      await signAccessToken(privateKey),
      await signIdToken(privateKey),
    )
    expect(result).toEqual({ ok: true, userId: 'did:privy:user-1' })
  })

  it('rejects a wallet that is not in the identity token linked accounts', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const verifier = createPrivyVerifier(
      baseConfig({ privyAppId: APP_ID, privyVerificationKey: await exportSPKI(publicKey) }),
    )
    if (!verifier) throw new Error('verifier missing')
    const result = await verifier.verify(
      OTHER,
      await signAccessToken(privateKey),
      await signIdToken(privateKey),
    )
    expect(result).toEqual({
      ok: false,
      reason: 'wallet is not linked to the verified Privy account',
    })
  })

  it('rejects an access token not signed with the configured key', async () => {
    const { publicKey } = await generateKeyPair('ES256')
    const { privateKey: otherKey } = await generateKeyPair('ES256')
    const verifier = createPrivyVerifier(
      baseConfig({ privyAppId: APP_ID, privyVerificationKey: await exportSPKI(publicKey) }),
    )
    if (!verifier) throw new Error('verifier missing')
    const result = await verifier.verify(
      WALLET,
      await signAccessToken(otherKey),
      await signIdToken(otherKey),
    )
    expect(result).toEqual({ ok: false, reason: 'access token signature or claims invalid' })
  })

  it('rejects an identity token not signed with the configured key', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const { privateKey: otherKey } = await generateKeyPair('ES256')
    const verifier = createPrivyVerifier(
      baseConfig({ privyAppId: APP_ID, privyVerificationKey: await exportSPKI(publicKey) }),
    )
    if (!verifier) throw new Error('verifier missing')
    const result = await verifier.verify(
      WALLET,
      await signAccessToken(privateKey),
      await signIdToken(otherKey),
    )
    expect(result).toEqual({ ok: false, reason: 'identity token invalid' })
  })

  it('rejects valid access and identity tokens that belong to different users', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256')
    const verifier = createPrivyVerifier(
      baseConfig({ privyAppId: APP_ID, privyVerificationKey: await exportSPKI(publicKey) }),
    )
    if (!verifier) throw new Error('verifier missing')
    const result = await verifier.verify(
      WALLET,
      await signAccessToken(privateKey, { subject: 'did:privy:user-1' }),
      await signIdToken(privateKey, { subject: 'did:privy:user-2' }),
    )
    expect(result).toEqual({
      ok: false,
      reason: 'access and identity tokens belong to different users',
    })
  })

  it('returns null without an app id, without both a secret and a key, or with a malformed key', async () => {
    expect(createPrivyVerifier(baseConfig())).toBeNull()
    expect(createPrivyVerifier(baseConfig({ privyAppId: APP_ID }))).toBeNull()
    expect(createPrivyVerifier(baseConfig({ privyVerificationKey: 'x' }))).toBeNull()
    expect(
      createPrivyVerifier(baseConfig({ privyAppId: APP_ID, privyVerificationKey: 'not-a-pem' })),
    ).toBeNull()
    expect(
      createPrivyVerifier(baseConfig({ privyAppId: APP_ID, privyAppSecret: 'secret' })),
    ).not.toBeNull()
  })
})
