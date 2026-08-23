import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerConfig } from './config'
import { issueChallenge, verifyChallenge } from './challenge'
import { issueAuthToken, resolveAuth, type AuthTokenPersistence } from './auth'
import { issueSession, restoreSession, getSession, consumeSession } from './sessions'
import {
  recoverPaymentSession,
  validatePayment,
  readLivePrice,
  type LivePriceResult,
} from './payments'
import { verifyRun } from './verify'
import {
  buildMetadata,
  seedCommitment,
  TIER_ASSET_EXTENSION,
  TIER_SLUGS,
  tierForVerifiedScore,
  toChainAttestation,
} from './rarity'
import { validateMetadata } from './pinner'
import type { AttestationRecord, Store } from './store'
import type { PrivyVerifier } from './privy'
import { DECK_SIZE } from '../../../src/game/sim/constants'

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
  /** Durable auth-token adapter. Production passes the hash-chained Store. */
  authPersistence?: AuthTokenPersistence
  /** Max concurrent in-flight requests (backpressure). Default 64. */
  maxConcurrentRequests?: number
}

const MAX_BODY_BYTES = 2 * 1024 * 1024

const TIER_ASSET_DIR = join(__dirname, '../../../public/assets/tiers')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWalletAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)
}

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Operator-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    Vary: 'Origin',
  })
  res.end(payload)
}

function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  allowOrigin: string | null,
  cacheControl: string,
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.byteLength),
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Operator-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': cacheControl,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    Vary: 'Origin',
  })
  res.end(body)
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

function validOperatorToken(header: string | undefined, expected: string | null): boolean {
  if (!expected || !header) return false
  const supplied = Buffer.from(header)
  const configured = Buffer.from(expected)
  return supplied.length === configured.length && timingSafeEqual(supplied, configured)
}

function acceptedSubmission(record: AttestationRecord) {
  return {
    status: 'accepted' as const,
    tokenId: record.tokenId,
    tier: {
      index: record.tier,
      name: record.tierName,
      slug: TIER_SLUGS[record.tier] ?? 'unknown',
    },
    score: record.score,
    caught: record.fliesCaught,
    missed: Math.max(0, DECK_SIZE - record.fliesCaught),
  }
}

export function createApp(deps: AppDeps) {
  const { config, store, buildHash } = deps
  const validate =
    deps.validatePayment ??
    ((cfg, st, tx, player, paymentId) => validatePayment(cfg, st, tx, player, paymentId))
  const livePrice = deps.priceReader ?? ((cfg) => readLivePrice(cfg))
  // Durable auth is the safe default even for a caller that forgets to wire
  // the optional test seam explicitly; production and local integrations use
  // the same Store-backed restart semantics.
  const authPersistence = deps.authPersistence ?? store

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
      if (
        store.integrity() === 'broken' &&
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        url.pathname !== '/health'
      ) {
        respond(503, { error: 'persistence integrity failure; operator action required' })
        return
      }
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

      // Local/dev metadata route. Production metadata is pinned by Pinata,
      // but the same canonical JSON remains available here for local mint
      // verification and for a recoverable status page.
      const metadataMatch = /^\/metadata\/([1-9]\d*)\.json$/.exec(url.pathname)
      if (req.method === 'GET' && metadataMatch) {
        const tokenId = Number(metadataMatch[1])
        const record = store.getAttestation(tokenId)
        if (!record) {
          respond(404, { error: 'unknown metadata' })
          return
        }
        let metadata: unknown = record.metadata
        try {
          metadata = JSON.parse(
            await readFile(join(config.dataDir, 'metadata', tokenId + '.json'), 'utf8'),
          ) as unknown
        } catch {
          // The append-only attestation is the recovery fallback if a local
          // metadata file was not written yet or was removed.
        }
        try {
          validateMetadata(metadata)
        } catch {
          respond(500, { error: 'stored metadata is invalid' })
          return
        }
        respond(200, metadata)
        return
      }

      const tierAssetMatch = new RegExp(
        '^/assets/tiers/(' + TIER_SLUGS.join('|') + ')\\.' + TIER_ASSET_EXTENSION + '$',
      ).exec(url.pathname)
      if (req.method === 'GET' && tierAssetMatch) {
        const slug = tierAssetMatch[1]
        try {
          const asset = await readFile(join(TIER_ASSET_DIR, slug + '.' + TIER_ASSET_EXTENSION))
          sendBytes(
            res,
            200,
            asset,
            'image/svg+xml; charset=utf-8',
            allowOrigin,
            'public, max-age=31536000, immutable',
          )
        } catch {
          respond(404, { error: 'tier asset not found' })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/attestations') {
        // Public transparency must not expose wallet addresses, session ids or
        // full metadata records. Owners can use the authenticated status route.
        respond(200, {
          attestations: store
            .listAttestations()
            .map(({ player, sessionId, metadata, ...publicRecord }) => {
              void player
              void sessionId
              void metadata
              return publicRecord
            }),
        })
        return
      }

      const requeueMatch = /^\/api\/admin\/mints\/(\d+)\/requeue$/.exec(url.pathname)
      if (req.method === 'POST' && requeueMatch) {
        if (!config.operatorToken) {
          respond(503, { error: 'operator recovery is not configured' })
          return
        }
        const operatorHeader = req.headers['x-operator-token']
        if (
          typeof operatorHeader !== 'string' ||
          !validOperatorToken(operatorHeader, config.operatorToken)
        ) {
          respond(401, { error: 'operator authentication required' })
          return
        }
        const tokenId = Number(requeueMatch[1])
        if (!store.requeueMint(tokenId)) {
          respond(409, { error: 'mint is not eligible for requeue' })
          return
        }
        respond(200, { status: 'queued', tokenId })
        return
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/status/')) {
        const address = resolveAuth(req.headers.authorization, authPersistence)
        if (!address) {
          respond(401, { error: 'authentication required' })
          return
        }
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
        if (record.player.toLowerCase() !== address.toLowerCase()) {
          respond(403, { error: 'status belongs to another wallet' })
          return
        }
        respond(200, { record })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/challenge') {
        const body = await readJsonBody(req)
        if (!isRecord(body) || typeof body.address !== 'string' || !isWalletAddress(body.address)) {
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
        const body = await readJsonBody(req)
        if (
          !isRecord(body) ||
          typeof body.address !== 'string' ||
          typeof body.accessToken !== 'string' ||
          typeof body.idToken !== 'string' ||
          !isWalletAddress(body.address)
        ) {
          respond(400, { error: 'address, accessToken, and idToken required' })
          return
        }
        const result = await verifier.verify(body.address, body.accessToken, body.idToken)
        if (!result.ok) {
          respond(401, { error: 'Privy verification failed', reason: result.reason })
          return
        }
        const auth = issueAuthToken(body.address, config.authTtlMs, authPersistence)
        respond(200, {
          authToken: auth.token,
          expiresAt: auth.expiresAt,
          address: body.address,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/verify') {
        const body = await readJsonBody(req)
        if (
          !isRecord(body) ||
          typeof body.address !== 'string' ||
          !isWalletAddress(body.address) ||
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
        const auth = issueAuthToken(recovered, config.authTtlMs, authPersistence)
        respond(200, { authToken: auth.token, expiresAt: auth.expiresAt, address: recovered })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        const address = resolveAuth(req.headers.authorization, authPersistence)
        if (!address) {
          respond(401, { error: 'authentication required' })
          return
        }
        const body = await readJsonBody(req)
        if (
          !isRecord(body) ||
          typeof body.paymentTxHash !== 'string' ||
          typeof body.paymentId !== 'string'
        ) {
          respond(400, { error: 'paymentTxHash and paymentId required' })
          return
        }
        const payment = await validate(config, store, body.paymentTxHash, address, body.paymentId)
        let session
        if (!payment.ok) {
          // The real validator durably records the payment before returning.
          // Recovering an existing binding makes a crash between payment
          // consumption and the HTTP response safe to retry. Injected test
          // validators retain the legacy one-shot behavior below.
          if (deps.validatePayment || payment.reason !== 'payment already used') {
            respond(payment.retryable ? 503 : 402, {
              error: payment.retryable
                ? 'payment validation temporarily unavailable'
                : 'payment validation failed',
              reason: payment.reason,
            })
            return
          }
          const recovered = recoverPaymentSession(store, {
            txHash: body.paymentTxHash,
            player: address,
            paymentId: body.paymentId,
            buildHash,
            ttlMs: config.sessionTtlMs,
          })
          if (!recovered.ok) {
            respond(402, { error: 'payment validation failed', reason: recovered.reason })
            return
          }
          session = restoreSession({
            ...recovered.session,
            paymentTxHash: recovered.session.txHash,
          })
        } else if (deps.validatePayment) {
          session = issueSession(address, body.paymentTxHash, buildHash, config.sessionTtlMs, {
            paymentId: body.paymentId,
          })
        } else {
          const recovered = recoverPaymentSession(store, {
            txHash: body.paymentTxHash,
            player: address,
            paymentId: body.paymentId,
            buildHash,
            ttlMs: config.sessionTtlMs,
          })
          if (!recovered.ok) {
            respond(500, { error: 'payment session recovery failed', reason: recovered.reason })
            return
          }
          session = restoreSession({
            ...recovered.session,
            paymentTxHash: recovered.session.txHash,
          })
        }
        if (!session) {
          respond(409, { error: 'payment session unavailable', reason: 'payment session expired' })
          return
        }
        respond(200, {
          sessionId: session.sessionId,
          seed: session.seed,
          buildHash,
          expiresAt: session.expiresAt,
          consumed: session.consumed,
          countdownTicks: config.countdownTicks,
          durationTicks: config.durationTicks,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/submit') {
        const address = resolveAuth(req.headers.authorization, authPersistence)
        if (!address) {
          respond(401, { error: 'authentication required' })
          return
        }
        const body = await readJsonBody(req)
        if (
          !isRecord(body) ||
          typeof body.sessionId !== 'string' ||
          typeof body.inputLogHash !== 'string'
        ) {
          respond(400, { error: 'sessionId, inputLog, and inputLogHash required' })
          return
        }
        let session = getSession(body.sessionId)
        if (!session) {
          const recovered = store.findPaymentSession(body.sessionId)
          if (recovered) {
            session = restoreSession({ ...recovered, paymentTxHash: recovered.txHash })
          }
        }
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

        // A response can be lost after the attestation is durably written.
        // Return that original result instead of replaying the run or
        // charging the player again. If the process died before the durable
        // consumed marker, finish that marker now.
        const existingAttestation = store.findAttestationBySession(body.sessionId, address)
        if (existingAttestation) {
          if (!session.consumed) {
            if (!deps.validatePayment) {
              store.consumePaymentSession(body.sessionId, address)
            }
            consumeSession(body.sessionId)
          }
          respond(200, acceptedSubmission(existingAttestation))
          return
        }
        if (session.consumed) {
          respond(409, { error: 'session already used' })
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
        const tier = tierForVerifiedScore(result.state.score)
        const tokenId = store.nextTokenIdValue()
        const commitment = seedCommitment(session.seed)
        const { json } = buildMetadata(
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
          // The generated local URI is returned by buildMetadata for
          // predictable routes, but it is not trusted until the pinner has
          // persisted/produced it. MintWorker writes the pinned URI before
          // sending any transaction.
          uri: '',
          metadata: json,
          status: 'queued',
          txHash: null,
          attempts: 0,
          updatedAt: new Date().toISOString(),
        })

        // Persist the attestation before consuming the durable session. If a
        // crash occurs between these two writes, the retry path above sees
        // the attestation and completes the consumed marker idempotently;
        // the paid session is never lost without a recoverable submission.
        if (!deps.validatePayment) {
          if (!store.consumePaymentSession(body.sessionId, address)) {
            respond(200, acceptedSubmission(store.getAttestation(tokenId)!))
            return
          }
          consumeSession(body.sessionId)
        } else if (!consumeSession(body.sessionId)) {
          respond(200, acceptedSubmission(store.getAttestation(tokenId)!))
          return
        }

        respond(200, acceptedSubmission(store.getAttestation(tokenId)!))
        return
      }

      respond(404, { error: 'not found' })
    } catch (error) {
      console.error('[http]', String(error))
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'body too large') {
        respond(413, { error: 'request body too large' })
      } else if (message === 'invalid JSON') {
        respond(400, { error: 'invalid JSON body' })
      } else {
        respond(500, { error: 'internal server error' })
      }
    } finally {
      inFlight -= 1
    }
  })
}
