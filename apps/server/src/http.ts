import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerConfig } from './config'
import { issueChallenge, verifyChallenge } from './challenge'
import { issueAuthToken, resolveAuth } from './auth'
import { issueSession, getSession, consumeSession } from './sessions'
import { validatePayment, readLivePrice, type LivePriceResult } from './payments'
import { verifyRun } from './verify'
import { buildMetadata, seedCommitment, tierForVerifiedScore, toChainAttestation } from './rarity'
import type { Store } from './store'
import type { PrivyVerifier } from './privy'

export interface AppDeps {
  config: ServerConfig
  store: Store
  buildHash: string
  /** Injectable for unit tests; production always uses the real chain validator. */
  validatePayment?: typeof validatePayment
  /** Injectable for unit tests; production always uses the real Privy client. */
  privyVerifier?: PrivyVerifier | null
  /** Injectable live-price reader for unit tests; production reads the chain. */
  priceReader?: (config: ServerConfig) => Promise<LivePriceResult>
  /** Max concurrent in-flight requests (backpressure). Default 64. */
  maxConcurrentRequests?: number
}

const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * CORS allowlist. An explicit CORS_ORIGINS list is authoritative; when empty
 * (dev default) only no-Origin requests and localhost/127.0.0.1 origins are
 * allowed. Disallowed origins get no Access-Control-Allow-Origin header, so
 * browsers cannot read the response. Vary: Origin is always sent so caches
 * do not mix origins.
 */
function allowedOrigin(origin: string | null | undefined, corsOrigins: string[]): string | null {
  if (!origin) return null
  if (corsOrigins.length > 0) {
    return corsOrigins.includes(origin) ? origin : null
  }
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '127.0.0.1' ? origin : null
  } catch {
    return null
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  allowOrigin: string | null,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  })
  res.end(payload)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function createApp(deps: AppDeps) {
  const { config, store, buildHash } = deps
  const validate =
    deps.validatePayment ??
    ((cfg, st, tx, player, paymentId) => validatePayment(cfg, st, tx, player, paymentId))
  const livePrice = deps.priceReader ?? ((cfg) => readLivePrice(cfg))

  // In-memory token-bucket rate limiting, per server instance (requests only;
  // this is NOT a paid-attempt cap - D4 keeps paid attempts unlimited).
  const buckets = new Map<string, { tokens: number; last: number }>()
  function takeToken(key: string, perMinute: number, burst: number): boolean {
    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: burst, last: now }
      buckets.set(key, bucket)
    } else {
      const refill = ((now - bucket.last) / 60_000) * perMinute
      bucket.tokens = Math.min(burst, bucket.tokens + refill)
      bucket.last = now
    }
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
  function pruneBuckets(): void {
    if (buckets.size < 10_000) return
    const cutoff = Date.now() - 5 * 60_000
    for (const [key, bucket] of buckets) {
      if (bucket.last < cutoff) buckets.delete(key)
    }
  }

  // In-flight counter for backpressure (see the request handler below).
  let inFlight = 0

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const allowOrigin = allowedOrigin(req.headers.origin, config.corsOrigins)
    const respond = (status: number, body: unknown) => sendJson(res, status, body, allowOrigin)
    const tooMany = (retryAfterSeconds: number) => {
      res.setHeader('Retry-After', String(retryAfterSeconds))
      respond(429, { error: 'too many requests' })
    }

    if (req.method === 'OPTIONS') {
      respond(204, {})
      return
    }

    pruneBuckets()
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (!takeToken(ip, config.rateLimitPerMinute, config.rateLimitBurst)) {
      tooMany(60)
      return
    }

    // Bounded concurrency/backpressure: shed excess load with a clear 503.
    const maxConcurrent = deps.maxConcurrentRequests ?? 64
    if (inFlight >= maxConcurrent) {
      res.setHeader('Retry-After', '5')
      respond(503, { error: 'server busy' })
      return
    }
    inFlight += 1

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        respond(200, {
          ok: true,
          chainId: config.chainId,
          buildHash,
          auditIntegrity: store.integrity(),
          time: new Date().toISOString(),
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const price = await livePrice(config)
        if (!price.ok) {
          respond(503, { error: 'could not read the on-chain price' })
          return
        }
        respond(200, {
          chainId: config.chainId,
          frong: config.frong,
          entry: config.entry,
          trophy: config.trophy,
          // LIVE on-chain price - never the stale deployment-record value.
          feeAmount: price.price.toString(),
          countdownTicks: config.countdownTicks,
          durationTicks: config.durationTicks,
          buildHash,
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/attestations') {
        respond(200, { attestations: store.listAttestations() })
        return
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/status/')) {
        const tokenId = Number(url.pathname.slice('/api/status/'.length))
        if (!Number.isInteger(tokenId) || tokenId <= 0) {
          respond(404, { error: 'unknown token' })
          return
        }
        const record = store.getAttestation(tokenId)
        if (!record) {
          respond(404, { error: 'unknown token' })
          return
        }
        respond(200, { record })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/challenge') {
        const body = (await readJsonBody(req)) as { address?: string }
        if (typeof body.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
          respond(400, { error: 'valid wallet address required' })
          return
        }
        // Throttle (D4): per-WALLET challenge budget. The global per-IP
        // bucket above already covers IP-level abuse. These are request
        // throttles, not gameplay caps - a legitimate player is only slowed
        // for seconds and other wallets on the same IP are unaffected.
        if (
          !takeToken(
            ip + ':addr:' + body.address.toLowerCase(),
            config.challengeRatePerMinute,
            config.challengeRatePerMinute,
          )
        ) {
          tooMany(60)
          return
        }
        const challenge = issueChallenge(body.address, config.chainId)
        respond(200, {
          nonce: challenge.nonce,
          message: challenge.message,
          issuedAt: challenge.issuedAt,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/verify/privy') {
        const verifier = deps.privyVerifier ?? null
        if (!verifier) {
          respond(503, { error: 'Privy verification is not configured on this server' })
          return
        }
        const body = (await readJsonBody(req)) as {
          address?: string
          accessToken?: string
          idToken?: string
        }
        if (
          typeof body.address !== 'string' ||
          typeof body.accessToken !== 'string' ||
          typeof body.idToken !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(body.address)
        ) {
          respond(400, { error: 'address, accessToken, and idToken required' })
          return
        }
        const result = await verifier.verify(body.address, body.accessToken, body.idToken)
        if (!result.ok) {
          respond(401, { error: 'Privy verification failed', reason: result.reason })
          return
        }
        const auth = issueAuthToken(body.address, config.authTtlMs)
        respond(200, {
          authToken: auth.token,
          expiresAt: auth.expiresAt,
          address: body.address,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/verify') {
        const body = (await readJsonBody(req)) as {
          address?: string
          nonce?: string
          signature?: string
        }
        if (
          typeof body.address !== 'string' ||
          typeof body.nonce !== 'string' ||
          typeof body.signature !== 'string'
        ) {
          respond(400, { error: 'address, nonce, and signature required' })
          return
        }
        const recovered = await verifyChallenge(body.address, body.nonce, body.signature)
        if (!recovered) {
          respond(401, { error: 'signature verification failed' })
          return
        }
        const auth = issueAuthToken(recovered, config.authTtlMs)
        respond(200, { authToken: auth.token, expiresAt: auth.expiresAt, address: recovered })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        const address = resolveAuth(req.headers.authorization)
        if (!address) {
          respond(401, { error: 'authentication required' })
          return
        }
        const body = (await readJsonBody(req)) as { paymentTxHash?: string; paymentId?: string }
        if (typeof body.paymentTxHash !== 'string' || typeof body.paymentId !== 'string') {
          respond(400, { error: 'paymentTxHash and paymentId required' })
          return
        }
        const payment = await validate(config, store, body.paymentTxHash, address, body.paymentId)
        if (!payment.ok) {
          respond(402, { error: 'payment validation failed', reason: payment.reason })
          return
        }
        const session = issueSession(address, body.paymentTxHash, buildHash, config.sessionTtlMs)
        respond(200, {
          sessionId: session.sessionId,
          seed: session.seed,
          buildHash,
          expiresAt: session.expiresAt,
          countdownTicks: config.countdownTicks,
          durationTicks: config.durationTicks,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/submit') {
        const address = resolveAuth(req.headers.authorization)
        if (!address) {
          respond(401, { error: 'authentication required' })
          return
        }
        const body = (await readJsonBody(req)) as {
          sessionId?: string
          inputLog?: unknown
          inputLogHash?: string
          buildHash?: string
        }
        if (typeof body.sessionId !== 'string' || typeof body.inputLogHash !== 'string') {
          respond(400, { error: 'sessionId, inputLog, and inputLogHash required' })
          return
        }
        const session = getSession(body.sessionId)
        if (!session) {
          respond(403, { error: 'submission rejected', reason: 'unknown or expired session' })
          return
        }
        if (session.player !== address) {
          respond(403, {
            error: 'submission rejected',
            reason: 'session belongs to another wallet',
          })
          return
        }
        // Build-hash binding: a client can only claim a score for the exact
        // sim build the server replays. Rejected BEFORE any verify/mint work.
        if (typeof body.buildHash !== 'string' || body.buildHash !== session.buildHash) {
          respond(403, { error: 'submission rejected', reason: 'build hash mismatch' })
          return
        }
        const result = verifyRun(config, session.seed, body.inputLog as never, body.inputLogHash)
        if (!result.ok) {
          respond(403, { error: 'submission rejected', reason: result.reason })
          return
        }
        if (!consumeSession(body.sessionId)) {
          respond(409, { error: 'session already used' })
          return
        }

        const tier = tierForVerifiedScore(result.state.score)
        const tokenId = store.nextTokenIdValue()
        const commitment = seedCommitment(session.seed)
        const { json, uri } = buildMetadata(
          config,
          tokenId,
          tier,
          result.state.score,
          result.state.caught,
          commitment,
        )
        const chainAttestation = toChainAttestation(
          tier.index,
          result.state.score,
          result.state.caught,
          commitment,
          result.inputLogHash,
          buildHash,
        )
        store.upsertAttestation({
          tokenId,
          player: session.player,
          sessionId: session.sessionId,
          tier: tier.index,
          tierName: tier.name,
          score: result.state.score,
          fliesCaught: result.state.caught,
          seedCommitment: commitment,
          inputLogHash: result.inputLogHash,
          buildHash,
          timestamp: Number(chainAttestation.timestamp),
          uri,
          metadata: json,
          status: 'queued',
          txHash: null,
          attempts: 0,
          updatedAt: new Date().toISOString(),
        })

        respond(200, {
          status: 'accepted',
          tokenId,
          tier: { index: tier.index, name: tier.name, slug: tier.slug },
          score: result.state.score,
          caught: result.state.caught,
          missed: result.state.missed,
        })
        return
      }

      respond(404, { error: 'not found' })
    } catch (error) {
      console.error('[http]', String(error))
      respond(400, { error: 'bad request' })
    } finally {
      inFlight -= 1
    }
  })
}
