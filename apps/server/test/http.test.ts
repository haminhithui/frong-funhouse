import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { createApp } from '../src/http'
import type { AppDeps } from '../src/http'
import { Store } from '../src/store'
import { hashInputLog } from '../src/verify'
import { LocalFilePinner } from '../src/pinner'
import type { AttestationRecord } from '../src/store'
import { createGame, stepGame, autoInput } from '../../../src/game/sim/sim'
import { TIERS, tierForScore } from '../../../src/game/sim/constants'
import type { InputFrame } from '../../../src/game/sim/types'
import { testConfig } from './config'

const PLAYER = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
)
const OTHER = privateKeyToAccount(
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
)

function freshTx(): string {
  return '0x' + randomBytes(32).toString('hex')
}

/** Builds an honest full input log for a seed (the bot plays; the log is real). */
function playFullLog(seed: number, countdownTicks: number, durationTicks: number): InputFrame[] {
  const state = createGame(seed, { countdownTicks, durationTicks })
  const inputs: InputFrame[] = []
  while (state.phase !== 'finished') {
    const input = autoInput(state)
    inputs.push(input)
    stepGame(state, input)
  }
  return inputs
}

describe('HTTP API (payment validator injected as a documented test double)', () => {
  const config = testConfig()
  const store = new Store(config.dataDir)
  let server: ReturnType<typeof createApp>
  let base = ''

  beforeAll(async () => {
    // The payment validator is the ONLY test double here. It mirrors the real
    // validator's contract (well-formed hash, one-time consumption) without
    // touching a chain — the real validator is proven separately in the
    // chain-backed integration suite and the browser E2E. Challenge signing,
    // replay verification, rarity, and the attestation log all run for real.
    const deps: AppDeps = {
      config,
      store,
      buildHash: 'be'.repeat(32),
      validatePayment: async (_cfg, st, txHash) => {
        if (!/^0x[0-9a-f]{64}$/.test(txHash))
          return { ok: false, reason: 'transaction not found on chain' }
        if (!st.consumePayment(txHash)) return { ok: false, reason: 'payment already used' }
        return { ok: true, blockNumber: 1n }
      },
      priceReader: async () => ({ ok: true, price: 1000n * 10n ** 18n }),
    }
    server = createApp(deps)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address && typeof address === 'object') base = 'http://127.0.0.1:' + address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function api(path: string, body: unknown, token?: string) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  async function verifiedToken(address: Address): Promise<string> {
    const challenge = await api('/api/challenge', { address })
    const account = address.toLowerCase() === PLAYER.address.toLowerCase() ? PLAYER : OTHER
    const signature = await account.signMessage({ message: challenge.body.message as string })
    const verify = await api('/api/verify', { address, nonce: challenge.body.nonce, signature })
    expect(verify.status).toBe(200)
    return verify.body.authToken as string
  }

  it('serves health and public config', async () => {
    const healthResponse = await fetch(base + '/health')
    const health = (await healthResponse.json()) as { ok: boolean }
    expect(health.ok).toBe(true)
    expect(healthResponse.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(healthResponse.headers.get('x-content-type-options')).toBe('nosniff')
    const cfg = (await (await fetch(base + '/api/config')).json()) as { feeAmount: string }
    // /api/config serves the LIVE on-chain price (injected reader), never the
    // stale deployment-record feeAmount.
    expect(cfg.feeAmount).toBe('1000000000000000000000')
  })

  it('runs the verified flow: challenge -> sign -> session -> submit -> attestation', async () => {
    const authToken = await verifiedToken(PLAYER.address)

    const tx = freshTx()
    const session = await api(
      '/api/session',
      { paymentTxHash: tx, paymentId: '0x' + 'cd'.repeat(32) },
      authToken,
    )
    expect(session.status).toBe(200)
    const { sessionId, seed, countdownTicks, durationTicks, buildHash } = session.body as {
      sessionId: string
      seed: number
      countdownTicks: number
      durationTicks: number
      buildHash: string
    }
    expect(buildHash).toBe('be'.repeat(32))

    const log = playFullLog(seed, countdownTicks, durationTicks)
    const submit = await api(
      '/api/submit',
      { sessionId, inputLog: log, inputLogHash: hashInputLog(log), buildHash: 'be'.repeat(32) },
      authToken,
    )
    expect(submit.status).toBe(200)
    expect(submit.body.status).toBe('accepted')
    const tokenId = submit.body.tokenId as number
    expect(submit.body.score).toBeTypeOf('number')

    const status = (await (
      await fetch(base + '/api/status/' + tokenId, {
        headers: { Authorization: 'Bearer ' + authToken },
      })
    ).json()) as {
      record: { status: string }
    }
    expect(status.record.status).toBe('queued')
    const attestations = (await (await fetch(base + '/api/attestations')).json()) as {
      attestations: Record<string, unknown>[]
    }
    const publicRecord = attestations.attestations.find((a) => a.tokenId === tokenId)
    expect(publicRecord).toBeDefined()
    expect(publicRecord).not.toHaveProperty('player')
    expect(publicRecord).not.toHaveProperty('sessionId')
    expect(publicRecord).not.toHaveProperty('metadata')

    // One session per payment, ever.
    const again = await api(
      '/api/session',
      { paymentTxHash: tx, paymentId: '0x' + 'cd'.repeat(32) },
      authToken,
    )
    expect(again.status).toBe(402)
    expect(again.body.reason).toBe('payment already used')
  })

  it('rejects a session for a payment that is not on chain', async () => {
    const authToken = await verifiedToken(PLAYER.address)
    const session = await api(
      '/api/session',
      { paymentTxHash: '0x123', paymentId: '0x' + '01'.repeat(32) },
      authToken,
    )
    expect(session.status).toBe(402)
    expect(session.body.reason).toBe('transaction not found on chain')
  })

  it('retries double submission of the same session idempotently', async () => {
    const authToken = await verifiedToken(PLAYER.address)
    const session = await api(
      '/api/session',
      { paymentTxHash: freshTx(), paymentId: '0x' + '23'.repeat(32) },
      authToken,
    )
    const { sessionId, seed, countdownTicks, durationTicks } = session.body as {
      sessionId: string
      seed: number
      countdownTicks: number
      durationTicks: number
    }
    const log = playFullLog(seed, countdownTicks, durationTicks)
    const payload = {
      sessionId,
      inputLog: log,
      inputLogHash: hashInputLog(log),
      buildHash: 'be'.repeat(32),
    }
    const first = await api('/api/submit', payload, authToken)
    expect(first.status).toBe(200)
    const second = await api('/api/submit', payload, authToken)
    expect(second.status).toBe(200)
    expect(second.body.status).toBe('accepted')
    expect(second.body.tokenId).toBe(first.body.tokenId)
  })

  it('requires authentication for session and submit', async () => {
    expect(
      (await api('/api/session', { paymentTxHash: freshTx(), paymentId: '0x' + '00'.repeat(32) }))
        .status,
    ).toBe(401)
    expect(
      (await api('/api/submit', { sessionId: 'x', inputLog: [], inputLogHash: 'y' })).status,
    ).toBe(401)
  })

  it('returns a client error for JSON primitives instead of leaking a server error', async () => {
    const challenge = await api('/api/challenge', null)
    expect(challenge.status).toBe(400)
    const verify = await api('/api/verify', null)
    expect(verify.status).toBe(400)
  })

  it('rejects a submission from a wallet that does not own the session', async () => {
    const ownerToken = await verifiedToken(PLAYER.address)
    const session = await api(
      '/api/session',
      { paymentTxHash: freshTx(), paymentId: '0x' + '45'.repeat(32) },
      ownerToken,
    )
    expect(session.status).toBe(200)

    const thiefToken = await verifiedToken(OTHER.address)
    const stolen = await api(
      '/api/submit',
      { sessionId: session.body.sessionId, inputLog: [], inputLogHash: 'z' },
      thiefToken,
    )
    expect(stolen.status).toBe(403)
    expect(stolen.body.reason).toBe('session belongs to another wallet')
  })

  it('answers 503 for Privy verification when Privy is not configured', async () => {
    const res = await api('/api/verify/privy', {
      address: PLAYER.address,
      accessToken: 'x',
      idToken: 'y',
    })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('Privy verification is not configured on this server')
  })

  it('verifies a Privy login through the real endpoint with an injected verifier', async () => {
    // Documented test double for the Privy client (the real client is proven
    // only against a real Privy app on the live server).
    const privyVerifier = {
      verify: async (_address: string, accessToken: string, idToken: string) =>
        accessToken === 'good-privy-token' && idToken === 'good-privy-id-token'
          ? { ok: true as const, userId: 'did:privy:user-1' }
          : { ok: false as const, reason: 'Privy token verification failed' },
    }
    const privyServer = createApp({
      config,
      store: new Store(config.dataDir),
      buildHash: 'be'.repeat(32),
      validatePayment: async () => ({ ok: true as const, blockNumber: 1n }),
      privyVerifier,
    })
    await new Promise<void>((resolve) => privyServer.listen(0, '127.0.0.1', resolve))
    const address = privyServer.address()
    const base2 = address && typeof address === 'object' ? 'http://127.0.0.1:' + address.port : ''
    try {
      // With a verifier present, a request missing the identity token is a 400.
      const missing = await fetch(base2 + '/api/verify/privy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: PLAYER.address, accessToken: 'good-privy-token' }),
      })
      expect(missing.status).toBe(400)
      expect(((await missing.json()) as { error: string }).error).toBe(
        'address, accessToken, and idToken required',
      )

      const ok = await fetch(base2 + '/api/verify/privy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: PLAYER.address,
          accessToken: 'good-privy-token',
          idToken: 'good-privy-id-token',
        }),
      })
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { authToken: string }
      expect(body.authToken).toMatch(/^[0-9a-f]{64}$/)

      const bad = await fetch(base2 + '/api/verify/privy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: PLAYER.address,
          accessToken: 'bad-token',
          idToken: 'good-privy-id-token',
        }),
      })
      expect(bad.status).toBe(401)
    } finally {
      await new Promise<void>((resolve) => privyServer.close(() => resolve()))
    }
  })

  it('rejects a forged signature in the verify step', async () => {
    const challenge = await api('/api/challenge', { address: PLAYER.address })
    const forged = await OTHER.signMessage({ message: challenge.body.message as string })
    const verify = await api('/api/verify', {
      address: PLAYER.address,
      nonce: challenge.body.nonce,
      signature: forged,
    })
    expect(verify.status).toBe(401)
  })

  it('rejects submissions with a missing or mismatched build hash before any attestation', async () => {
    const authToken = await verifiedToken(PLAYER.address)
    const session = await api(
      '/api/session',
      { paymentTxHash: freshTx(), paymentId: '0x' + '67'.repeat(32) },
      authToken,
    )
    const { sessionId, seed, countdownTicks, durationTicks } = session.body as {
      sessionId: string
      seed: number
      countdownTicks: number
      durationTicks: number
    }
    const log = playFullLog(seed, countdownTicks, durationTicks)
    const missing = await api(
      '/api/submit',
      { sessionId, inputLog: log, inputLogHash: hashInputLog(log) },
      authToken,
    )
    expect(missing.status).toBe(403)
    expect(missing.body.reason).toBe('build hash mismatch')

    const wrong = await api(
      '/api/submit',
      { sessionId, inputLog: log, inputLogHash: hashInputLog(log), buildHash: 'cd'.repeat(32) },
      authToken,
    )
    expect(wrong.status).toBe(403)
    expect(wrong.body.reason).toBe('build hash mismatch')

    // Mismatch never consumes the session: the correct hash still succeeds.
    const good = await api(
      '/api/submit',
      { sessionId, inputLog: log, inputLogHash: hashInputLog(log), buildHash: 'be'.repeat(32) },
      authToken,
    )
    expect(good.status).toBe(200)
    expect(good.body.status).toBe('accepted')
  })

  it('D3: accepts a no-skill idle run (no score floor) and derives rarity from the score', async () => {
    const authToken = await verifiedToken(PLAYER.address)
    const session = await api(
      '/api/session',
      { paymentTxHash: freshTx(), paymentId: '0x' + '89'.repeat(32) },
      authToken,
    )
    const { sessionId, countdownTicks, durationTicks } = session.body as {
      sessionId: string
      countdownTicks: number
      durationTicks: number
    }
    const idle = Array.from({ length: countdownTicks + durationTicks }, () => ({
      targetX: 240,
      axis: 0 as const,
    }))
    const submit = await api(
      '/api/submit',
      { sessionId, inputLog: idle, inputLogHash: hashInputLog(idle), buildHash: 'be'.repeat(32) },
      authToken,
    )
    expect(submit.status).toBe(200)
    expect(submit.body.status).toBe('accepted')
    const score = submit.body.score as number
    const tier = submit.body.tier as { name: string }
    expect(tier.name).toBe(TIERS[tierForScore(score)].name)
  })

  it('CORS: echoes allowed localhost origins and omits ACAO for foreign origins', async () => {
    const allowed = await fetch(base + '/health', { headers: { Origin: 'http://127.0.0.1:8080' } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080')
    expect(allowed.headers.get('vary')).toContain('Origin')

    const blocked = await fetch(base + '/health', { headers: { Origin: 'https://evil.example' } })
    expect(blocked.status).toBe(200)
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull()

    const none = await fetch(base + '/health')
    expect(none.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('HTTP API hardening (rate limits, CORS allowlist, live-price failures)', () => {
  async function withServer(
    overrides: Parameters<typeof testConfig>[0],
    run: (base: string) => Promise<void>,
    deps: Partial<AppDeps> = {},
  ) {
    const cfg = testConfig(overrides)
    const server = createApp({
      config: cfg,
      store: new Store(cfg.dataDir),
      buildHash: 'be'.repeat(32),
      validatePayment: async () => ({ ok: true as const, blockNumber: 1n }),
      priceReader: async () => ({ ok: true, price: 1n }),
      ...deps,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const base = address && typeof address === 'object' ? 'http://127.0.0.1:' + address.port : ''
    try {
      await run(base)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('rate-limits requests per IP', async () => {
    await withServer({ rateLimitPerMinute: 2, rateLimitBurst: 2 }, async (base) => {
      expect((await fetch(base + '/health')).status).toBe(200)
      expect((await fetch(base + '/health')).status).toBe(200)
      const limited = await fetch(base + '/health')
      expect(limited.status).toBe(429)
      expect(((await limited.json()) as { error: string }).error).toBe('too many requests')
      // Clear temporary-rejection semantics: Retry-After is always present.
      expect(limited.headers.get('retry-after')).toBe('60')
    })
  })

  it('applies a stricter per-wallet limit to challenge issuance (requests only, no paid-attempt cap)', async () => {
    await withServer(
      { rateLimitPerMinute: 60, rateLimitBurst: 60, challengeRatePerMinute: 1 },
      async (base) => {
        const first = await fetch(base + '/api/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: '0x' + '11'.repeat(20) }),
        })
        expect(first.status).toBe(200)
        const second = await fetch(base + '/api/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: '0x' + '11'.repeat(20) }),
        })
        expect(second.status).toBe(429)
        expect(((await second.json()) as { error: string }).error).toBe('too many requests')
      },
    )
  })

  it('CORS: explicit allowlist admits listed origins only', async () => {
    await withServer({ corsOrigins: ['https://play.example.com'] }, async (base) => {
      const ok = await fetch(base + '/health', { headers: { Origin: 'https://play.example.com' } })
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://play.example.com')
      const denied = await fetch(base + '/health', { headers: { Origin: 'https://other.example' } })
      expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  it('returns 503 from /api/config when the live price cannot be read', async () => {
    const cfg = testConfig()
    const server = createApp({
      config: cfg,
      store: new Store(cfg.dataDir),
      buildHash: 'be'.repeat(32),
      priceReader: async () => ({ ok: false, reason: 'could not read the on-chain price' }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const base = address && typeof address === 'object' ? 'http://127.0.0.1:' + address.port : ''
    try {
      const res = await fetch(base + '/api/config')
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toBe(
        'could not read the on-chain price',
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('throttles challenge issuance per wallet address without blocking other wallets', async () => {
    await withServer(
      { rateLimitPerMinute: 60, rateLimitBurst: 60, challengeRatePerMinute: 1 },
      async (base) => {
        const challenge = async (address: string) =>
          fetch(base + '/api/challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address }),
          })
        const first = await challenge(PLAYER.address)
        expect(first.status).toBe(200)
        const second = await challenge(PLAYER.address)
        expect(second.status).toBe(429)
        expect(second.headers.get('retry-after')).toBe('60')
        const other = await challenge(OTHER.address)
        expect(other.status).toBe(200)
      },
    )
  })

  it('sheds excess concurrency with a clear 503 instead of queueing unbounded', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await withServer(
      { rateLimitPerMinute: 60, rateLimitBurst: 60, challengeRatePerMinute: 60 },
      async (base) => {
        const post = async (path: string, body: unknown, token?: string) => {
          const res = await fetch(base + path, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: 'Bearer ' + token } : {}),
            },
            body: JSON.stringify(body),
          })
          return { status: res.status, body: (await res.json()) as Record<string, unknown> }
        }
        const challenge = await post('/api/challenge', { address: PLAYER.address })
        const signature = await PLAYER.signMessage({ message: challenge.body.message as string })
        const verify = await post('/api/verify', {
          address: PLAYER.address,
          nonce: challenge.body.nonce,
          signature,
        })
        const token = verify.body.authToken as string
        const pending = Promise.all([
          post(
            '/api/session',
            { paymentTxHash: freshTx(), paymentId: '0x' + '31'.repeat(32) },
            token,
          ),
          post(
            '/api/session',
            { paymentTxHash: freshTx(), paymentId: '0x' + '32'.repeat(32) },
            token,
          ),
        ])
        // Let the second request observe the busy state, then release the gate.
        await new Promise((resolve) => setTimeout(resolve, 150))
        release()
        const [first, second] = await pending
        const statuses = [first.status, second.status].sort()
        expect(statuses).toContain(503)
        const busy = [first, second].find((r) => r.status === 503)
        expect(busy?.body.error).toBe('server busy')
      },
      {
        maxConcurrentRequests: 1,
        validatePayment: async () => {
          await gate
          return { ok: true as const, blockNumber: 1n }
        },
      },
    )
  })

  it('protects operator requeue with a separate credential and terminal-state checks', async () => {
    const operatorToken = 'operator-test-token-' + 'x'.repeat(32)
    const cfg = testConfig({ operatorToken })
    const store = new Store(cfg.dataDir)
    store.upsertAttestation({
      tokenId: 77,
      player: PLAYER.address,
      sessionId: 'terminal-session',
      tier: 0,
      tierName: 'Tadpole',
      score: 0,
      fliesCaught: 0,
      seedCommitment: 'a'.repeat(64),
      inputLogHash: 'b'.repeat(64),
      buildHash: 'c'.repeat(64),
      timestamp: 1_700_000_000,
      uri: 'http://127.0.0.1:8787/metadata/77.json',
      metadata: { name: 'terminal' },
      status: 'delayed',
      txHash: null,
      attempts: 5,
      updatedAt: new Date().toISOString(),
    })
    const server = createApp({
      config: cfg,
      store,
      buildHash: 'be'.repeat(32),
      priceReader: async () => ({ ok: true as const, price: 1n }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const base = address && typeof address === 'object' ? 'http://127.0.0.1:' + address.port : ''
    try {
      const request = (token?: string) =>
        fetch(base + '/api/admin/mints/77/requeue', {
          method: 'POST',
          headers: token ? { 'X-Operator-Token': token } : undefined,
        })
      expect((await request()).status).toBe(401)
      expect((await request('wrong-token')).status).toBe(401)
      expect((await request(operatorToken)).status).toBe(200)
      expect(store.getAttestation(77)?.status).toBe('queued')
      expect((await request(operatorToken)).status).toBe(409)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('metadata and status routes', () => {
  it('serves locally pinned metadata, tier artwork, and persisted status', async () => {
    const config = testConfig()
    const store = new Store(config.dataDir)
    const metadata = {
      name: 'FRONG Catch Trophy #1 — Tadpole',
      description: 'Replay-verified run: 20/109 points.',
      image: config.metadataBaseUrl + '/assets/tiers/tadpole.svg',
      attributes: [{ trait_type: 'Tier', value: 'Tadpole' }],
    }
    const record: AttestationRecord = {
      tokenId: 1,
      player: PLAYER.address,
      sessionId: 'metadata-session',
      tier: 0,
      tierName: 'Tadpole',
      score: 20,
      fliesCaught: 10,
      seedCommitment: 'a'.repeat(64),
      inputLogHash: 'b'.repeat(64),
      buildHash: 'c'.repeat(64),
      timestamp: 1_700_000_000,
      uri: '',
      metadata,
      status: 'queued',
      txHash: null,
      attempts: 0,
      updatedAt: new Date().toISOString(),
    }
    store.upsertAttestation(record)
    await new LocalFilePinner(config.dataDir, config.metadataBaseUrl).pinMetadata(1, metadata)

    const server = createApp({
      config,
      store,
      buildHash: 'be'.repeat(32),
      priceReader: async () => ({ ok: true as const, price: 1n }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const base = address && typeof address === 'object' ? 'http://127.0.0.1:' + address.port : ''
    try {
      const metadataResponse = await fetch(base + '/metadata/1.json')
      expect(metadataResponse.status).toBe(200)
      expect(metadataResponse.headers.get('content-type')).toContain('application/json')
      expect(((await metadataResponse.json()) as { name: string }).name).toContain('#1')

      const assetResponse = await fetch(base + '/assets/tiers/tadpole.svg')
      expect(assetResponse.status).toBe(200)
      expect(assetResponse.headers.get('content-type')).toContain('image/svg+xml')
      expect(await assetResponse.text()).toContain('<svg')

      const challenge = await fetch(base + '/api/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: PLAYER.address }),
      })
      const challengeBody = (await challenge.json()) as { nonce: string; message: string }
      const signature = await PLAYER.signMessage({ message: challengeBody.message })
      const verify = await fetch(base + '/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: PLAYER.address, nonce: challengeBody.nonce, signature }),
      })
      const verifyBody = (await verify.json()) as { authToken: string }
      const statusResponse = await fetch(base + '/api/status/1', {
        headers: { Authorization: 'Bearer ' + verifyBody.authToken },
      })
      expect(statusResponse.status).toBe(200)
      expect(((await statusResponse.json()) as { record: AttestationRecord }).record.uri).toBe('')

      expect((await fetch(base + '/metadata/999.json')).status).toBe(404)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
