/**
 * Focused tests for the PURE challenge helper in src/auth/challenge.ts
 * (buildSignedChallenge / buildChallengeMessage / parseChallengeFields /
 * computeChallengeHash + the issueWalletChallenge persistence wrapper):
 *
 *   node --test apps/worker/test/challenge.test.ts
 *
 * (Also runs in-process — `node apps/worker/test/challenge.test.ts` — for
 * sandboxes that block the test runner's child-process spawning.)
 *
 * Pinned contract under test:
 *   - The message format is BYTE-EXACT and stable (the future wallet
 *     signature verification rebuilds this exact payload): header line,
 *     blank line, Address / Nonce / Issued At / Chain ID lines, '\n'
 *     separated, no trailing newline.
 *   - Deterministic: same fields in -> identical message + digest out;
 *     mixed-case addresses are NORMALIZED to lowercase.
 *   - Fail-closed validation, never throwing: invalid wallet address,
 *     invalid chain id (non-positive/fractional/non-number), empty or
 *     whitespace-only nonce, unparseable stamps, and expiresAt not
 *     strictly after issuedAt are rejected with a typed reason.
 *   - The hash is a ONE-WAY sha-256 lowercase-hex digest of the nonce —
 *     exactly the 64-hex shape wallet_challenges.challenge_hash stores —
 *     cross-checked here against Node's independent node:crypto sha256.
 *   - The persistence wrapper (issueWalletChallenge) hands the repo ONLY
 *     the digest + metadata: the raw nonce never appears in any repo
 *     input, and nothing is persisted for an invalid input.
 *
 * No network, no D1, no real entropy: synthetic addresses/timestamps and
 * injected randomBytes/now seams.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  CHALLENGE_TTL_MS,
  ChallengeConflictError,
  buildChallengeMessage,
  buildSignedChallenge,
  challengeMessage,
  computeChallengeHash,
  isValidChainId,
  parseChallengeFields,
  issueWalletChallenge,
} from '../src/auth/challenge.ts'
import type {
  AuthRepo,
  ConsumeChallengeInput,
  ConsumeChallengeResult,
  GetChallengeOptions,
  IssueChallengeInput,
  IssueChallengeResult,
  IssueTokenInput,
  IssueTokenResult,
  ResolveTokenOptions,
  ResolveTokenResult,
  RevokeTokenResult,
  WalletChallengeRecord,
} from '../src/auth/repo.ts'

// ---- fixtures (synthetic; no real deployment, wallet, or endpoint) ----------

const PLAYER_MIXED = '0xAbC0000000000000000000000000000000000dE1'
const PLAYER_LOWER = PLAYER_MIXED.toLowerCase()
const CHAIN_ID = 46630 // project testnet (staging) chain
const NONCE = '0123456789abcdef0123456789abcdef'
const ISSUED_AT = '2026-07-05T12:00:00.000Z'
const EXPIRES_AT = '2026-07-05T12:05:00.000Z' // issuedAt + CHALLENGE_TTL_MS

/** Independent sha-256 implementation — never the code under test. */
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** The pinned, byte-exact message for the fixtures above. */
const PINNED_MESSAGE = [
  'frong-catch.fan wants you to sign in with your wallet.',
  '',
  `Address: ${PLAYER_LOWER}`,
  `Nonce: ${NONCE}`,
  `Issued At: ${ISSUED_AT}`,
  `Chain ID: ${CHAIN_ID}`,
].join('\n')

const validFields = (): Record<string, unknown> => ({
  address: PLAYER_MIXED,
  chainId: CHAIN_ID,
  nonce: NONCE,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
})

/** Reject (narrowed) and return the typed reason; throws on acceptance. */
function rejectReason(input: unknown): string {
  const parsed = parseChallengeFields(input)
  if (parsed.ok) throw new Error(`expected a rejection, got fields for ${parsed.fields.address}`)
  return parsed.reason
}

// ---- message format: stable and byte-pinned ----------------------------------

test('challengeMessage builds the pinned payload byte-exactly (no trailing newline)', () => {
  const message = challengeMessage(PLAYER_LOWER, NONCE, ISSUED_AT, CHAIN_ID)
  assert.equal(message, PINNED_MESSAGE)
  assert.ok(message.endsWith(`Chain ID: ${CHAIN_ID}`))
  assert.ok(!message.endsWith('\n'))
  assert.equal(message.split('\n').length, 6)
})

test('buildChallengeMessage normalizes a mixed-case address and is deterministic', async () => {
  const first = buildChallengeMessage(validFields())
  const second = buildChallengeMessage(validFields())
  assert.ok(first.ok)
  assert.ok(second.ok)
  assert.equal(first.message, PINNED_MESSAGE)
  assert.equal(first.fields.address, PLAYER_LOWER, 'address is lowercased')
  assert.equal(first.message, second.message, 'same fields -> identical bytes')
})

test('buildSignedChallenge returns the pinned message, normalized fields, and the digest', async () => {
  const built = await buildSignedChallenge(validFields())
  assert.ok(built.ok)
  assert.equal(built.message, PINNED_MESSAGE)
  assert.equal(built.address, PLAYER_LOWER)
  assert.equal(built.chainId, CHAIN_ID)
  assert.equal(built.issuedAt, ISSUED_AT)
  assert.equal(built.expiresAt, EXPIRES_AT)
  assert.equal(built.challengeHash, sha256(NONCE))
})

// ---- address validation ------------------------------------------------------

test('invalid wallets are rejected (shape, checksum-hex, zero address, non-string)', () => {
  const bad: unknown[] = [
    'not-an-address',
    '0x1234',
    '0x' + 'zz'.repeat(20),
    '0x' + 'ab'.repeat(39), // 39 bytes
    '0x' + '0'.repeat(40), // zero address is not a player
    '',
    42,
    null,
    undefined,
    [PLAYER_LOWER],
    { address: PLAYER_LOWER },
  ]
  for (const address of bad) {
    assert.equal(
      rejectReason({ ...validFields(), address }),
      'invalid_address',
      `expected rejection for ${String(address)}`,
    )
  }
})

test('any 0x-hex casing is accepted and normalized to lowercase', () => {
  const parsed = parseChallengeFields({ ...validFields(), address: PLAYER_MIXED })
  assert.ok(parsed.ok)
  assert.equal(parsed.fields.address, PLAYER_LOWER)
})

// ---- chain id validation -----------------------------------------------------

test('isValidChainId accepts positive safe integers only', () => {
  for (const good of [1, 31337, CHAIN_ID, 4663, 12345, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isValidChainId(good), true, `expected valid: ${String(good)}`)
  }
  for (const bad of [0, -1, -46630, 1.5, NaN, Infinity, -Infinity, '46630', null, undefined]) {
    assert.equal(isValidChainId(bad), false, `expected invalid: ${String(bad)}`)
  }
})

test('invalid chain ids are rejected by the pure builder', () => {
  for (const chainId of [0, -1, 1.5, NaN, Infinity, '46630', null, undefined]) {
    assert.equal(
      rejectReason({ ...validFields(), chainId }),
      'invalid_chain_id',
      `expected rejection for ${String(chainId)}`,
    )
  }
})

// ---- nonce validation --------------------------------------------------------

test('empty or whitespace-only nonces are rejected', () => {
  for (const nonce of ['', '   ', '\t\n']) {
    assert.equal(
      rejectReason({ ...validFields(), nonce }),
      'empty_nonce',
      `expected rejection for ${JSON.stringify(nonce)}`,
    )
  }
  // non-strings never reach a digest either
  for (const nonce of [42, null, undefined]) {
    assert.equal(rejectReason({ ...validFields(), nonce }), 'empty_nonce')
  }
})

test('computeChallengeHash refuses to digest an empty nonce (fail-closed)', async () => {
  await assert.rejects(computeChallengeHash(''), TypeError)
  await assert.rejects(computeChallengeHash('  '), TypeError)
})

// ---- timestamp validation ----------------------------------------------------

test('unparseable or non-positive TTL stamps are rejected', () => {
  assert.equal(rejectReason({ ...validFields(), issuedAt: 'nope' }), 'invalid_issued_at')
  assert.equal(rejectReason({ ...validFields(), issuedAt: 42 }), 'invalid_issued_at')
  assert.equal(rejectReason({ ...validFields(), expiresAt: 'nope' }), 'invalid_expires_at')
  assert.equal(rejectReason({ ...validFields(), expiresAt: null }), 'invalid_expires_at')
  // a challenge must not be born expired (mirrors expires_at > created_at)
  assert.equal(rejectReason({ ...validFields(), expiresAt: ISSUED_AT }), 'invalid_expires_at')
  assert.equal(
    rejectReason({ ...validFields(), expiresAt: '2026-07-05T11:59:59.000Z' }),
    'invalid_expires_at',
  )
})

test('the first failing field is reported deterministically', () => {
  assert.equal(
    rejectReason({ address: 'nope', chainId: 0, nonce: '', issuedAt: 'x', expiresAt: 'y' }),
    'invalid_address',
  )
  // non-object inputs are rejected, never thrown
  for (const input of [null, undefined, 42, 'address', [validFields()]]) {
    assert.equal(parseChallengeFields(input).ok, false)
  }
})

// ---- hash: one-way digest, pinned to the D1 challenge_hash shape -------------

test('the challenge hash is the independent sha-256 of the nonce, 64 lowercase hex', async () => {
  const digest = await computeChallengeHash(NONCE)
  assert.equal(digest, sha256(NONCE), 'matches an independent sha-256 implementation')
  assert.match(digest, /^[0-9a-f]{64}$/, 'exactly the wallet_challenges.challenge_hash shape')
  assert.notEqual(digest, NONCE, 'the digest is not the nonce')
  assert.ok(!digest.includes(NONCE), 'the nonce is not embedded in the digest')
})

test('digests are deterministic per nonce and distinct across nonces', async () => {
  const other = 'fedcba9876543210fedcba9876543210'
  assert.equal(await computeChallengeHash(NONCE), await computeChallengeHash(NONCE))
  assert.notEqual(await computeChallengeHash(NONCE), await computeChallengeHash(other))
  // a one-hex-character change flips the digest (avalanche / one-wayness smell)
  const flipped = await computeChallengeHash('1' + NONCE.slice(1))
  assert.notEqual(flipped, await computeChallengeHash(NONCE))
})

test('the built result leaks the raw nonce only inside the client-facing message', async () => {
  const built = await buildSignedChallenge(validFields())
  assert.ok(built.ok)
  for (const [key, value] of Object.entries(built)) {
    if (key === 'message') continue
    assert.ok(
      !JSON.stringify(value).includes(NONCE),
      `persistence-safe field "${key}" must not contain the raw nonce`,
    )
  }
  // the message line is the payload the WALLET signs — nonce in it is by design
  assert.ok(built.message.includes(`Nonce: ${NONCE}`))
})

// ---- persistence wrapper: digest-only storage, validation before any repo call

/** Deterministic entropy seam: bytes 0x00..0x0f -> a fixed 32-hex nonce. */
const DRAWN_NONCE = '000102030405060708090a0b0c0d0e0f'
const DRAWN_MESSAGE = PINNED_MESSAGE.replace(`Nonce: ${NONCE}`, `Nonce: ${DRAWN_NONCE}`)
const ISSUE_NOW = Date.parse(ISSUED_AT)
const drawnBytes = (length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => i & 0xff)

/** AuthRepo fake: records issueChallenge inputs; every other method is
 * unreachable in these tests and fails loudly if called. */
class RecordingAuthRepo implements AuthRepo {
  issueCalls: IssueChallengeInput[] = []
  nextOutcome: 'issued' | 'already_issued' = 'issued'
  async issueChallenge(input: IssueChallengeInput): Promise<IssueChallengeResult> {
    this.issueCalls.push(input)
    const record: WalletChallengeRecord = {
      challengeId: 'challenge-1',
      player: input.player,
      challengeHash: input.challengeHash,
      status: 'pending',
      paymentId: null,
      createdAt: input.at ?? ISSUED_AT,
      expiresAt: input.expiresAt,
      consumedAt: null,
      updatedAt: input.at ?? ISSUED_AT,
    }
    if (this.nextOutcome === 'already_issued') return { outcome: 'already_issued', record }
    return { outcome: 'issued', record }
  }
  async getChallenge(
    _id: string,
    _options?: GetChallengeOptions,
  ): Promise<WalletChallengeRecord | null> {
    throw new Error('not used by these tests')
  }
  async consumeChallenge(_input: ConsumeChallengeInput): Promise<ConsumeChallengeResult> {
    throw new Error('not used by these tests')
  }
  async issueToken(_input: IssueTokenInput): Promise<IssueTokenResult> {
    throw new Error('not used by these tests')
  }
  async resolveToken(_hash: string, _options?: ResolveTokenOptions): Promise<ResolveTokenResult> {
    throw new Error('not used by these tests')
  }
  async revokeToken(_input: { tokenHash: string; at?: string }): Promise<RevokeTokenResult> {
    throw new Error('not used by these tests')
  }
}

test('issueWalletChallenge persists ONLY the digest + metadata, never the nonce', async () => {
  const repo = new RecordingAuthRepo()
  const issued = await issueWalletChallenge(
    repo,
    { address: PLAYER_MIXED, chainId: CHAIN_ID },
    {
      // deterministic seams: fixed entropy and clock, no real CSPRNG needed
      randomBytes: drawnBytes,
      now: () => ISSUE_NOW,
    },
  )
  assert.equal(issued.nonce, DRAWN_NONCE, 'the raw nonce goes to the CLIENT, not the store')
  assert.equal(issued.message, DRAWN_MESSAGE)
  assert.equal(issued.issuedAt, ISSUED_AT)
  assert.equal(issued.expiresAt, EXPIRES_AT, 'issuedAt + TTL')
  assert.equal(CHALLENGE_TTL_MS, 5 * 60 * 1000)

  assert.equal(repo.issueCalls.length, 1)
  const [call] = repo.issueCalls
  assert.equal(call.player, PLAYER_LOWER, 'persistence sees the lowercased address')
  assert.equal(call.challengeHash, sha256(DRAWN_NONCE), 'persistence sees sha256(nonce)')
  assert.ok(
    !JSON.stringify(call).includes(DRAWN_NONCE),
    'no repo input field carries the raw nonce',
  )
  assert.ok(
    !JSON.stringify(issued.record).includes(DRAWN_NONCE),
    'no stored field carries the raw nonce',
  )
})

test('issueWalletChallenge validates before touching the repo and fails closed', async () => {
  const repo = new RecordingAuthRepo()
  await assert.rejects(
    issueWalletChallenge(repo, { address: 'not-an-address', chainId: CHAIN_ID }),
    TypeError,
  )
  await assert.rejects(issueWalletChallenge(repo, { address: PLAYER_LOWER, chainId: 0 }), TypeError)
  assert.equal(repo.issueCalls.length, 0, 'nothing is persisted for an invalid input')

  repo.nextOutcome = 'already_issued'
  await assert.rejects(
    issueWalletChallenge(
      repo,
      { address: PLAYER_LOWER, chainId: CHAIN_ID },
      {
        randomBytes: drawnBytes,
        now: () => ISSUE_NOW,
      },
    ),
    ChallengeConflictError,
  )
})
