import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { AuthToken, AuthTokenPersistence } from './auth'

export type MintStatus = 'queued' | 'minting' | 'minted' | 'delayed' | 'rejected'

export interface AttestationRecord {
  tokenId: number
  player: string
  sessionId: string
  tier: number
  tierName: string
  score: number
  fliesCaught: number
  seedCommitment: string
  inputLogHash: string
  buildHash: string
  timestamp: number
  uri: string
  metadata: unknown
  status: MintStatus
  txHash: string | null
  attempts: number
  updatedAt: string
}

export interface PaymentIdentity {
  player: string
  paymentId: string
}

/** Durable session material bound to a payment after chain validation. */
export interface PaymentSessionRecord extends PaymentIdentity {
  txHash: string
  sessionId: string
  seed: number
  buildHash: string
  createdAt: number
  expiresAt: number
  consumed: boolean
}

export interface PaymentSessionInput extends PaymentIdentity {
  txHash: string
  buildHash: string
  ttlMs: number
}

export type PaymentSessionResult =
  | { ok: true; created: boolean; session: PaymentSessionRecord }
  | {
      ok: false
      reason:
        | 'payment not consumed'
        | 'payment identity unavailable'
        | 'payment identity mismatch'
        | 'payment session conflict'
        | 'payment session consumed'
        | 'invalid session parameters'
    }

export interface ConsumedPaymentRecord extends PaymentIdentity {
  txHash: string
  consumedAt: string
  session?: PaymentSessionRecord
}

/** Audit-chain state. 'ok' = every chained line verified on load. */
export type AuditIntegrity = 'ok' | 'broken'

/** Chain anchor for lines written before the hash chain existed (legacy
 * data is adopted as a trusted baseline - documented, not silently verified). */
const GENESIS = 'genesis'
const localLocks = new Map<string, number>()

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH means the old owner died and its stale lock can be reclaimed.
    // EPERM and unknown errors are treated as alive so we fail closed.
    return errorCode(error) !== 'ESRCH'
  }
}

function acquireStoreLock(lockPath: string, key: string): void {
  const localCount = localLocks.get(key)
  if (localCount) {
    localLocks.set(key, localCount + 1)
    return
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n',
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      localLocks.set(key, 1)
      return
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      let ownerPid: number
      try {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }
        ownerPid = Number(lock.pid)
      } catch {
        throw new Error('data directory lock is unreadable: ' + lockPath)
      }
      if (Number.isInteger(ownerPid) && ownerPid > 0 && processIsAlive(ownerPid)) {
        throw new Error('data directory is already owned by process ' + ownerPid)
      }
      try {
        unlinkSync(lockPath)
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== 'ENOENT') throw unlinkError
      }
    }
  }
  throw new Error('could not acquire data directory lock: ' + lockPath)
}

function releaseStoreLock(lockPath: string, key: string): void {
  const localCount = localLocks.get(key)
  if (!localCount) return
  if (localCount > 1) {
    localLocks.set(key, localCount - 1)
    return
  }
  localLocks.delete(key)
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      console.error('[store] could not release data directory lock:', String(error))
    }
  }
}

/**
 * Append-only, hash-chained data store. Every fact is appended to a JSONL
 * file; updates append new lines (latest wins on load), so nothing is ever
 * silently rewritten. Each appended line carries _prev (the previous line's
 * hash) and _hash = sha256(_prev + NUL + canonical(line)) - a standard
 * SHA-256 hash chain, no custom signing. On load every chained line is
 * re-verified; a broken chain is reported (never a silent pass) and the
 * store keeps serving. Auth-token digests and payment/session bindings are
 * also journaled so a restart does not silently invalidate recovery or replay
 * protection.
 */
export const STORE_PERSISTENCE_SCOPE = 'single-process-exclusive' as const

export class Store implements AuthTokenPersistence {
  private attestations = new Map<number, AttestationRecord>()
  private nextTokenId = 1
  private consumedPayments = new Map<string, ConsumedPaymentRecord>()
  private authTokens = new Map<string, AuthToken>()
  private lastHashes = new Map<string, string>()
  private broken = false
  private readonly dataDir: string
  private readonly lockPath: string
  private readonly lockKey: string
  private closed = false

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir)
    mkdirSync(this.dataDir, { recursive: true })
    this.lockPath = join(this.dataDir, '.frong-store.lock')
    this.lockKey = this.dataDir
    acquireStoreLock(this.lockPath, this.lockKey)
    try {
      this.load()
    } catch (error) {
      releaseStoreLock(this.lockPath, this.lockKey)
      throw error
    }
  }

  /** Releases the single-process guard during an orderly server shutdown. */
  close(): void {
    if (this.closed) return
    this.closed = true
    releaseStoreLock(this.lockPath, this.lockKey)
  }

  /** Strips chain fields; the canonical form is the record as written. */
  private canonical(value: object): string {
    const rest: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key !== '_prev' && key !== '_hash') rest[key] = entry
    }
    return JSON.stringify(rest)
  }

  private chainHash(prev: string, canonical: string): string {
    return createHash('sha256')
      .update(prev + '\u0000' + canonical)
      .digest('hex')
  }

  /** Reads a JSONL stream, verifies the hash chain, returns clean records. */
  private readLines(filename: string): object[] {
    const file = join(this.dataDir, filename)
    if (!existsSync(file)) return []
    const parsed: object[] = []
    let prev = GENESIS
    let chainStarted = false
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let value: Record<string, unknown>
      try {
        value = JSON.parse(line) as Record<string, unknown>
      } catch {
        this.broken = true
        console.error('[store] corrupt line in', filename, '- chain marked broken')
        continue
      }
      const hasChainFields = '_hash' in value || '_prev' in value
      if (typeof value._hash === 'string' && /^[0-9a-f]{64}$/.test(value._hash)) {
        const claimedPrev = String(value._prev ?? GENESIS)
        const expected = this.chainHash(claimedPrev, this.canonical(value))
        if (claimedPrev !== prev || expected !== value._hash) {
          this.broken = true
          console.error('[store] hash-chain mismatch in', filename, '- chain marked broken')
        }
        prev = value._hash
        chainStarted = true
      } else if (hasChainFields) {
        this.broken = true
        console.error('[store] invalid hash-chain fields in', filename, '- chain marked broken')
      } else {
        // Legacy lines are accepted only before the first chained line. An
        // unhashed append after that point would otherwise reset the chain
        // and let an attacker inject data without detection.
        if (chainStarted) {
          this.broken = true
          console.error(
            '[store] unhashed line after hash chain in',
            filename,
            '- chain marked broken',
          )
        } else {
          prev = GENESIS
        }
      }
      const clean: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        if (key !== '_prev' && key !== '_hash') clean[key] = entry
      }
      parsed.push(clean as object)
    }
    this.lastHashes.set(filename, prev)
    return parsed
  }

  private load(): void {
    for (const entry of this.readLines('token-ids.jsonl')) {
      const record = entry as { tokenId: number }
      if (record.tokenId >= this.nextTokenId) this.nextTokenId = record.tokenId + 1
    }
    for (const entry of this.readLines('attestations.jsonl')) {
      const record = entry as AttestationRecord
      this.attestations.set(record.tokenId, record)
      if (record.tokenId >= this.nextTokenId) this.nextTokenId = record.tokenId + 1
    }
    for (const entry of this.readLines('payments.jsonl')) {
      const value = entry as Record<string, unknown>
      if (typeof value.txHash !== 'string' || value.txHash.length === 0) continue
      const txHash = value.txHash.toLowerCase()
      const previous = this.consumedPayments.get(txHash)
      const player =
        typeof value.player === 'string' && value.player.length > 0
          ? value.player.toLowerCase()
          : previous?.player
      const paymentId =
        typeof value.paymentId === 'string' && value.paymentId.length > 0
          ? value.paymentId.toLowerCase()
          : previous?.paymentId
      const consumedAt =
        typeof value.consumedAt === 'string' && value.consumedAt.length > 0
          ? value.consumedAt
          : (previous?.consumedAt ?? '')
      const session = this.parsePaymentSession(value, txHash) ?? previous?.session
      if (!player || !paymentId) {
        // Legacy records only contain the transaction hash. Keep them visible
        // for idempotency, but never use them for identity recovery.
        this.consumedPayments.set(txHash, {
          txHash,
          player: player ?? '',
          paymentId: paymentId ?? '',
          consumedAt,
          ...(session ? { session } : {}),
        })
        continue
      }
      this.consumedPayments.set(txHash, {
        txHash,
        player,
        paymentId,
        consumedAt,
        ...(session ? { session } : {}),
      })
    }
    for (const entry of this.readLines('auth.jsonl')) {
      const value = entry as Record<string, unknown>
      if (
        typeof value.tokenHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.tokenHash) ||
        typeof value.address !== 'string' ||
        typeof value.expiresAt !== 'number'
      ) {
        this.broken = true
        continue
      }
      this.authTokens.set(value.tokenHash, {
        address: value.address.toLowerCase(),
        expiresAt: value.expiresAt,
      })
    }
  }

  private parsePaymentSession(
    value: Record<string, unknown>,
    txHash: string,
  ): PaymentSessionRecord | undefined {
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.player !== 'string' ||
      typeof value.paymentId !== 'string' ||
      typeof value.seed !== 'number' ||
      !Number.isInteger(value.seed) ||
      value.seed < 0 ||
      typeof value.buildHash !== 'string' ||
      typeof value.createdAt !== 'number' ||
      typeof value.expiresAt !== 'number'
    ) {
      return undefined
    }
    return {
      txHash,
      player: value.player.toLowerCase(),
      paymentId: value.paymentId.toLowerCase(),
      sessionId: value.sessionId,
      seed: value.seed >>> 0,
      buildHash: value.buildHash,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      consumed: value.consumed === true,
    }
  }

  private append(filename: string, value: object): void {
    const canonical = this.canonical(value)
    const prev = this.lastHashes.get(filename) ?? GENESIS
    const hash = this.chainHash(prev, canonical)
    const record = { ...value, _prev: prev, _hash: hash }
    const fd = openSync(join(this.dataDir, filename), 'a')
    try {
      writeSync(fd, JSON.stringify(record) + '\n', undefined, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.lastHashes.set(filename, hash)
  }

  /** Claims the next sequential, collision-free token id. */
  nextTokenIdValue(): number {
    const id = this.nextTokenId
    this.nextTokenId += 1
    this.append('token-ids.jsonl', { tokenId: id, assignedAt: new Date().toISOString() })
    return id
  }

  /** Records a payment tx hash as consumed. Returns false if already used. */
  consumePayment(txHash: string, identity?: PaymentIdentity): boolean {
    const key = txHash.toLowerCase()
    if (this.consumedPayments.has(key)) return false
    const consumedAt = new Date().toISOString()
    const player = identity?.player.toLowerCase() ?? ''
    const paymentId = identity?.paymentId.toLowerCase() ?? ''
    this.append('payments.jsonl', {
      txHash: key,
      consumedAt,
      ...(identity ? { player, paymentId } : {}),
    })
    this.consumedPayments.set(key, { txHash: key, player, paymentId, consumedAt })
    return true
  }

  /**
   * Returns the durable payment record. Legacy hash-only records intentionally
   * expose empty identity fields and cannot be used for session recovery.
   */
  getPaymentRecord(txHash: string): ConsumedPaymentRecord | undefined {
    const record = this.consumedPayments.get(txHash.toLowerCase())
    if (!record) return undefined
    return {
      ...record,
      ...(record.session ? { session: { ...record.session } } : {}),
    }
  }

  /** Returns the durable session bound to a payment, if identity matches. */
  getPaymentSession(txHash: string, identity?: PaymentIdentity): PaymentSessionRecord | undefined {
    const record = this.consumedPayments.get(txHash.toLowerCase())
    if (!record?.session) return undefined
    if (
      identity &&
      (record.player !== identity.player.toLowerCase() ||
        record.paymentId !== identity.paymentId.toLowerCase())
    ) {
      return undefined
    }
    return { ...record.session }
  }

  /**
   * Atomically appends the payment-to-session binding to the payment journal.
   * Repeated calls with the same payment identity return the original session,
   * including after a process restart. A hash-only legacy payment is rejected
   * because its player/paymentId cannot be recovered safely.
   *
   * The journal mutation is synchronous and durable for this Store instance;
   * the store is deliberately single-process and is not a multi-instance
   * coordination mechanism. A shared transactional store and worker lease are
   * required before running more than one server replica; this implementation
   * takes an exclusive process lock so an accidental second writer fails closed.
   */
  getOrCreatePaymentSession(input: PaymentSessionInput): PaymentSessionResult {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || !input.buildHash) {
      return { ok: false, reason: 'invalid session parameters' }
    }
    const txHash = input.txHash.toLowerCase()
    const player = input.player.toLowerCase()
    const paymentId = input.paymentId.toLowerCase()
    const record = this.consumedPayments.get(txHash)
    if (!record) return { ok: false, reason: 'payment not consumed' }
    if (!record.player || !record.paymentId) {
      return { ok: false, reason: 'payment identity unavailable' }
    }
    if (record.player !== player || record.paymentId !== paymentId) {
      return { ok: false, reason: 'payment identity mismatch' }
    }
    if (record.session) {
      // Repeating /api/session after a successful submit is idempotent: return
      // the original session so a lost HTTP response cannot look like a new
      // payment. The submit route still rejects this consumed session.
      if (record.session.consumed) {
        return { ok: true, created: false, session: { ...record.session } }
      }
      if (
        record.session.player !== player ||
        record.session.paymentId !== paymentId ||
        record.session.buildHash !== input.buildHash
      ) {
        return { ok: false, reason: 'payment session conflict' }
      }
      return { ok: true, created: false, session: { ...record.session } }
    }

    const createdAt = Date.now()
    const session: PaymentSessionRecord = {
      txHash,
      player,
      paymentId,
      sessionId: randomBytes(16).toString('hex'),
      seed: randomBytes(4).readUInt32BE(0) >>> 0,
      buildHash: input.buildHash,
      createdAt,
      expiresAt: createdAt + input.ttlMs,
      consumed: false,
    }
    this.append('payments.jsonl', {
      txHash,
      player,
      paymentId,
      consumedAt: record.consumedAt,
      sessionId: session.sessionId,
      seed: session.seed,
      buildHash: session.buildHash,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      consumed: session.consumed,
      sessionBoundAt: new Date().toISOString(),
    })
    this.consumedPayments.set(txHash, { ...record, session })
    return { ok: true, created: true, session: { ...session } }
  }

  /** Finds a durable session after a process restart without trusting a client-supplied owner. */
  findPaymentSession(sessionId: string): PaymentSessionRecord | undefined {
    for (const record of this.consumedPayments.values()) {
      if (record.session?.sessionId === sessionId) return { ...record.session }
    }
    return undefined
  }

  /** Atomically records the one-use transition in the append-only payment journal. */
  consumePaymentSession(sessionId: string, player: string): boolean {
    const normalizedPlayer = player.toLowerCase()
    for (const [txHash, record] of this.consumedPayments) {
      const session = record.session
      if (!session || session.sessionId !== sessionId) continue
      if (session.player !== normalizedPlayer || session.consumed) return false
      const consumedSession = { ...session, consumed: true }
      this.append('payments.jsonl', {
        txHash,
        player: record.player,
        paymentId: record.paymentId,
        consumedAt: record.consumedAt,
        sessionId: consumedSession.sessionId,
        seed: consumedSession.seed,
        buildHash: consumedSession.buildHash,
        createdAt: consumedSession.createdAt,
        expiresAt: consumedSession.expiresAt,
        consumed: true,
        sessionConsumedAt: new Date().toISOString(),
      })
      this.consumedPayments.set(txHash, { ...record, session: consumedSession })
      return true
    }
    return false
  }

  putAuthToken(tokenHash: string, record: AuthToken): void {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('invalid auth token hash')
    const normalized = { address: record.address.toLowerCase(), expiresAt: record.expiresAt }
    this.append('auth.jsonl', { tokenHash, ...normalized })
    this.authTokens.set(tokenHash, normalized)
  }

  getAuthToken(tokenHash: string): AuthToken | undefined {
    const record = this.authTokens.get(tokenHash)
    if (!record || record.expiresAt <= Date.now()) return undefined
    return { ...record }
  }

  pruneAuthTokens(now: number): void {
    for (const [tokenHash, record] of this.authTokens) {
      if (record.expiresAt <= now) this.authTokens.delete(tokenHash)
    }
  }

  upsertAttestation(record: AttestationRecord): void {
    this.attestations.set(record.tokenId, record)
    this.append('attestations.jsonl', record)
  }

  getAttestation(tokenId: number): AttestationRecord | undefined {
    return this.attestations.get(tokenId)
  }

  /** Finds the accepted submission for a session so retries are idempotent. */
  findAttestationBySession(sessionId: string, player?: string): AttestationRecord | undefined {
    const normalizedPlayer = player?.toLowerCase()
    for (const record of this.attestations.values()) {
      if (record.sessionId !== sessionId) continue
      if (normalizedPlayer && record.player.toLowerCase() !== normalizedPlayer) continue
      return { ...record }
    }
    return undefined
  }

  listAttestations(): AttestationRecord[] {
    return [...this.attestations.values()].sort((a, b) => a.tokenId - b.tokenId)
  }

  /** Records queued for (re-)minting after a restart or a delay. */
  pendingMints(): AttestationRecord[] {
    return this.listAttestations().filter(
      (record) =>
        record.status === 'queued' || record.status === 'minting' || record.status === 'delayed',
    )
  }

  /** Reopens only a terminal delayed record with no submitted transaction. */
  requeueMint(tokenId: number): boolean {
    const record = this.attestations.get(tokenId)
    if (!record || record.status !== 'delayed' || record.attempts < 5 || record.txHash !== null) {
      return false
    }
    this.upsertAttestation({
      ...record,
      status: 'queued',
      attempts: 0,
      updatedAt: new Date().toISOString(),
    })
    return true
  }

  /** Audit-chain status after the last load: 'ok' or 'broken'. */
  integrity(): AuditIntegrity {
    return this.broken ? 'broken' : 'ok'
  }
}

/** Writes pinned metadata to the data dir atomically; the URI is final at mint. */
export function writeMetadataFile(dataDir: string, tokenId: number, metadata: unknown): string {
  const dir = join(dataDir, 'metadata')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, tokenId + '.json')
  const tmp = file + '.' + process.pid + '.' + randomBytes(8).toString('hex') + '.tmp'
  const body = JSON.stringify(metadata, null, 2)
  if (body === undefined) throw new Error('metadata is not JSON-serializable')
  try {
    const fd = openSync(tmp, 'wx')
    try {
      writeSync(fd, body, undefined, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Preserve the original write/rename error.
    }
    throw error
  }
  return file
}
