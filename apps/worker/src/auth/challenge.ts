/**
 * POST /api/challenge domain logic — durable wallet-challenge issuance.
 *
 * Scope: the SMALLEST durable auth step. This module creates a one-time
 * SIWE-style challenge for a wallet, persists ONLY the SHA-256 digest of
 * the nonce (plus the challenge metadata the auth repository already
 * owns: player, status, created/expires stamps) through
 * createAuthRepo(db).issueChallenge, and hands the RAW nonce + message +
 * issuedAt back to the caller for the client to sign. No signature
 * verification, Privy, payment, session, or mint logic lives here — the
 * later verify phase recomputes sha256(nonce) to find the stored row.
 *
 * SECURITY CONTRACT:
 *   * The nonce is 128 bits from crypto.getRandomValues — the
 *     Workers-compatible CSPRNG (also global in Node >= 18, so the same
 *     code runs in-process tests). Nothing seeds or caches it: every call
 *     draws fresh entropy, and there is NO in-memory nonce/auth Map.
 *   * Persistence sees the digest only. `issueWalletChallenge` hashes the
 *     nonce BEFORE the repository call, and the repository additionally
 *     rejects any non-64-hex value, so a raw nonce, signature, or key can
 *     never reach a column (migration 0002's length CHECK is the second
 *     line of defense, the absence of any other column the third).
 *   * The message format is byte-identical to the Node server's
 *     challengeMessage (apps/server/src/challenge.ts) so the client — and
 *     the future verify phase — rebuild the exact signed payload.
 *
 * Timestamps: ISO-8601 UTC (Date.toISOString()), matching the repo's TEXT
 * columns and the frontend contract. A challenge is consumable strictly
 * until expires_at (= issuedAt + CHALLENGE_TTL_MS, the server's 5-minute
 * window), and the repository persists that expiry as metadata.
 *
 * Pure core (below): buildSignedChallenge / buildChallengeMessage /
 * computeChallengeHash are PURE and TEST-PINNED — deterministic fields
 * (address, chainId, nonce, issuedAt, expiresAt) in, pinned message +
 * sha256(nonce) digest out; they validate (normalize the address, reject
 * invalid chain/address/empty nonce/stamps) and never touch entropy, the
 * clock, D1, or HTTP. issueWalletChallenge is only the entropy + repo
 * wrapper around that core.
 */

import type { AuthRepo, WalletChallengeRecord } from './repo.ts'

/** Challenge lifetime in ms — matches the Node server's SIWE window. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

/** Entropy per nonce: 16 bytes = 128 bits, hex-encoded to 32 chars. */
const NONCE_BYTES = 16

/** A freshly issued, durably persisted wallet challenge. */
export interface ChallengeIssued {
  /** Raw one-time nonce (32 lowercase hex chars) — client-visible only. */
  nonce: string
  /** Exact human-readable payload the wallet must sign. */
  message: string
  /** ISO-8601 UTC issue instant (persisted as created_at). */
  issuedAt: string
  /** ISO-8601 UTC instant the challenge stops being consumable. */
  expiresAt: string
  /** The stored wallet_challenges row (digest + metadata, never the nonce). */
  record: WalletChallengeRecord
}

/**
 * The repo reported a stored row for this digest (already_issued /
 * identity_conflict). With a fresh 128-bit nonce this is unreachable
 * except on a digest collision or a misbehaving store; the caller fails
 * closed instead of returning a challenge whose nonce it cannot know.
 */
export class ChallengeConflictError extends Error {
  readonly outcome: string
  constructor(outcome: string) {
    super(`auth challenge: unexpected issueChallenge outcome ${outcome}`)
    this.name = 'ChallengeConflictError'
    this.outcome = outcome
  }
}

/**
 * Wallet address shape accepted from the client: '0x' + 40 hex chars,
 * excluding the all-zero address. Mirrors the Node server's
 * isWalletAddress so both ends of the contract agree.
 */
export function isValidWalletAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)
}

/**
 * Validate the frontend challenge body shape and canonicalize the address.
 * Returns the LOWERCASED address on success, null for anything else (wrong
 * shape, missing/non-string address, invalid or zero address). Never
 * throws: a malformed body is a 400, not a 500.
 */
export function parseChallengeAddress(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const address = (body as { address?: unknown }).address
  if (typeof address !== 'string' || !isValidWalletAddress(address)) return null
  return address.toLowerCase()
}

/**
 * The exact payload the wallet signs. Byte-identical to the Node server's
 * message (apps/server/src/challenge.ts): the future verify phase and any
 * client display depend on this exact spelling.
 */
export function challengeMessage(
  address: string,
  nonce: string,
  issuedAt: string,
  chainId: number,
): string {
  return [
    'frong-catch.fan wants you to sign in with your wallet.',
    '',
    'Address: ' + address,
    'Nonce: ' + nonce,
    'Issued At: ' + issuedAt,
    'Chain ID: ' + chainId,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// PURE, TEST-PINNED CHALLENGE BUILDER — deterministic fields in, pinned
// message + one-way digest out. No entropy, clock, D1, or HTTP anywhere in
// this section: `buildSignedChallenge` is the exact shape the future route
// calls with ITS OWN nonce/stamps, so the message a wallet signs and the
// digest stored in wallet_challenges.challenge_hash both derive from one
// validated place.
// ---------------------------------------------------------------------------

/** The deterministic fields a challenge is built from — nothing else. */
export interface ChallengeFields {
  /** Claiming wallet; any 0x-hex casing, normalized to lowercase. */
  address: string
  /** EVM chain id the challenge binds to (positive safe integer). */
  chainId: number
  /** One-time nonce; must be non-empty (entropy is the issuer's job). */
  nonce: string
  /** ISO-8601 UTC issue instant (canonical spelling: Date.toISOString()). */
  issuedAt: string
  /** ISO-8601 UTC instant the challenge stops being consumable. */
  expiresAt: string
}

/** Which deterministic field failed validation (first failure wins). */
export type ChallengeRejectReason =
  | 'invalid_address'
  | 'invalid_chain_id'
  | 'empty_nonce'
  | 'invalid_issued_at'
  | 'invalid_expires_at'

/** Fail-closed validation result — a reason, never a thrown error. */
export interface ChallengeRejected {
  ok: false
  reason: ChallengeRejectReason
  detail: string
}

/** Normalized challenge fields: address lowercased, everything else as given. */
export interface ChallengeAccepted {
  ok: true
  fields: ChallengeFields
}

/**
 * Chain-id shape accepted by the pure builder: a positive safe integer.
 * WHICH chains a deployment may bind stays an environment concern
 * (loadWorkerConfig allowlists 31337/46630/4663); this is only the
 * structural guard, so the builder never bakes config into pure logic.
 */
export function isValidChainId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER
  )
}

/**
 * Validate and normalize the deterministic challenge fields (fail-closed,
 * never throws): address must be a valid non-zero wallet (lowercased),
 * chainId a positive safe integer, nonce a non-empty string, and both
 * stamps parseable ISO-8601 with expiresAt STRICTLY after issuedAt (a
 * challenge born expired is a caller bug — same rule as the D1
 * `expires_at > created_at` CHECK and the repo's RangeError).
 * Fields are checked in a fixed order so the first failure is deterministic.
 */
export function parseChallengeFields(input: unknown): ChallengeAccepted | ChallengeRejected {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_address', detail: 'challenge fields: not an object' }
  }
  const { address, chainId, nonce, issuedAt, expiresAt } = input as Record<string, unknown>

  if (typeof address !== 'string' || !isValidWalletAddress(address)) {
    return {
      ok: false,
      reason: 'invalid_address',
      detail: `not a wallet address: ${String(address)}`,
    }
  }
  if (!isValidChainId(chainId)) {
    return { ok: false, reason: 'invalid_chain_id', detail: `not a chain id: ${String(chainId)}` }
  }
  if (typeof nonce !== 'string' || nonce.trim() === '') {
    return { ok: false, reason: 'empty_nonce', detail: 'nonce must be a non-empty string' }
  }
  if (typeof issuedAt !== 'string' || Number.isNaN(Date.parse(issuedAt))) {
    return {
      ok: false,
      reason: 'invalid_issued_at',
      detail: `not an ISO-8601 instant: ${String(issuedAt)}`,
    }
  }
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    return {
      ok: false,
      reason: 'invalid_expires_at',
      detail: `not an ISO-8601 instant: ${String(expiresAt)}`,
    }
  }
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    return {
      ok: false,
      reason: 'invalid_expires_at',
      detail: `expiresAt (${expiresAt}) must be after issuedAt (${issuedAt})`,
    }
  }

  return {
    ok: true,
    fields: { address: address.toLowerCase(), chainId, nonce, issuedAt, expiresAt },
  }
}

/** Result of the pure, sync message builder. */
export type ChallengeMessageResult =
  { ok: true; message: string; fields: ChallengeFields } | ChallengeRejected

/**
 * Pure message construction: validate the deterministic fields (normalizing
 * the address to lowercase) and return the exact pinned payload the wallet
 * signs. Deterministic — same fields in, byte-identical message out; no
 * entropy, clock, or I/O. Rejections never throw.
 */
export function buildChallengeMessage(input: unknown): ChallengeMessageResult {
  const parsed = parseChallengeFields(input)
  if (!parsed.ok) return parsed
  const { address, chainId, nonce, issuedAt } = parsed.fields
  return {
    ok: true,
    message: challengeMessage(address, nonce, issuedAt, chainId),
    fields: parsed.fields,
  }
}

/** Result of the pure, async challenge builder (message + digest). */
export type SignedChallengeResult =
  | {
      ok: true
      /** Normalized (lowercased) wallet the challenge binds. */
      address: string
      chainId: number
      /** Exact pinned payload the wallet signs (contains the nonce BY
       * DESIGN — it is client-facing, never a persistence value). */
      message: string
      issuedAt: string
      expiresAt: string
      /** sha256(nonce) — the one-way digest for challenge_hash; the ONLY
       * value here that is ever handed toward persistence. */
      challengeHash: string
    }
  | ChallengeRejected

/**
 * The one pure challenge helper: validate + normalize the deterministic
 * fields, build the pinned message, and compute the one-way SHA-256 digest
 * of the nonce (the representation the D1 challenge_hash column stores).
 * Deterministic on its inputs — the caller supplies nonce and stamps; the
 * raw nonce is NOT echoed outside `message`, so everything except the
 * client-facing message line is persistence-safe by construction.
 */
export async function buildSignedChallenge(
  input: unknown,
  deps: Pick<ChallengeDeps, 'sha256Hex'> = {},
): Promise<SignedChallengeResult> {
  const parsed = parseChallengeFields(input)
  if (!parsed.ok) return parsed
  const message = buildChallengeMessage(parsed.fields)
  if (!message.ok) return message // unreachable (same validated fields)
  return {
    ok: true,
    address: parsed.fields.address,
    chainId: parsed.fields.chainId,
    message: message.message,
    issuedAt: parsed.fields.issuedAt,
    expiresAt: parsed.fields.expiresAt,
    challengeHash: await computeChallengeHash(parsed.fields.nonce, deps),
  }
}

/** Injectable seams so unit tests never touch real entropy or clock. */
export interface ChallengeDeps {
  /** CSPRNG source; production uses crypto.getRandomValues (Workers). */
  randomBytes?: (length: number) => Uint8Array
  /** Digest source; production uses crypto.subtle (SHA-256, Workers). */
  sha256Hex?: (value: string) => Promise<string>
  /** Epoch-ms clock; production uses Date.now. */
  now?: () => number
}

/** Workers-compatible CSPRNG draw (crypto.getRandomValues is a Workers
 * and Node global; no node:crypto import anywhere in src/). */
function workersRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

/** Lowercase-hex encoding of a byte sequence. */
function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** SHA-256 lowercase-hex digest via the WebCrypto available in Workers. */
async function workersSha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return toHex(new Uint8Array(digest))
}

/**
 * The one-way challenge hash: SHA-256 lowercase hex of the nonce — exactly
 * the 64-hex shape wallet_challenges.challenge_hash stores (and the repo's
 * normalizeDigest + schema CHECK enforce). The digest is the ONLY persisted
 * representation; the nonce itself is never derivable from it. Rejects an
 * empty/whitespace-only or non-string nonce before hashing (fail-closed,
 * defense in depth under buildSignedChallenge's validation).
 */
export async function computeChallengeHash(
  nonce: string,
  deps: Pick<ChallengeDeps, 'sha256Hex'> = {},
): Promise<string> {
  if (typeof nonce !== 'string' || nonce.trim() === '') {
    throw new TypeError('challenge hash: nonce must be a non-empty string')
  }
  const sha256Hex = deps.sha256Hex ?? workersSha256Hex
  return sha256Hex(nonce)
}

/**
 * Issue one durable challenge for `address` on `chainId`: draw a fresh
 * 128-bit nonce, stamp issued/expires metadata, persist ONLY
 * sha256(nonce) through the auth repository, and return the raw nonce +
 * message + issuedAt for the client. Throws (fail-closed) when the
 * repository fails or reports anything but a fresh 'issued' row; the raw
 * nonce is never re-derivable from what was stored.
 */
export async function issueWalletChallenge(
  repo: AuthRepo,
  input: { address: string; chainId: number },
  deps: ChallengeDeps = {},
): Promise<ChallengeIssued> {
  const randomBytes = deps.randomBytes ?? workersRandomBytes
  const sha256Hex = deps.sha256Hex ?? workersSha256Hex
  const now = deps.now ?? Date.now

  const nonce = toHex(randomBytes(NONCE_BYTES))
  const issuedAt = new Date(now()).toISOString()
  const expiresAt = new Date(Date.parse(issuedAt) + CHALLENGE_TTL_MS).toISOString()

  // Single source of truth: the pure, validated builder (address
  // normalization, chain/nonce/stamp rejection, pinned message, digest)
  // produces everything below; this issuance only draws the entropy and
  // stamps, then persists ONLY what it returns.
  const built = await buildSignedChallenge(
    { address: input.address, chainId: input.chainId, nonce, issuedAt, expiresAt },
    { sha256Hex },
  )
  if (!built.ok) {
    throw new TypeError(`auth challenge: rejected ${built.reason}: ${built.detail}`)
  }

  // The ONLY value handed to persistence is the digest — hashed before
  // the repository is ever touched, so the raw nonce cannot leak into a
  // bind parameter, a column, or an error path below.
  const result = await repo.issueChallenge({
    player: built.address,
    challengeHash: built.challengeHash,
    expiresAt: built.expiresAt,
    at: built.issuedAt,
  })
  if (result.outcome !== 'issued') throw new ChallengeConflictError(result.outcome)

  return {
    nonce,
    message: built.message,
    issuedAt: built.issuedAt,
    expiresAt: built.expiresAt,
    record: result.record,
  }
}
