import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/store'
import { testConfig } from './config'
import type { AttestationRecord } from '../src/store'

function record(tokenId: number, status: AttestationRecord['status']): AttestationRecord {
  return {
    tokenId,
    player: '0x' + 'ab'.repeat(20),
    sessionId: 'session-' + tokenId,
    tier: 4,
    tierName: 'Just FRONG.',
    score: 85,
    fliesCaught: 40,
    seedCommitment: 'a'.repeat(64),
    inputLogHash: 'b'.repeat(64),
    buildHash: 'c'.repeat(64),
    timestamp: 1_700_000_000,
    uri: 'http://x/metadata/' + tokenId + '.json',
    metadata: { name: 'test' },
    status,
    txHash: null,
    attempts: 0,
    updatedAt: new Date().toISOString(),
  }
}

describe('append-only store', () => {
  it('assigns sequential, collision-free token ids across restarts', () => {
    const config = testConfig()
    const first = new Store(config.dataDir)
    expect(first.nextTokenIdValue()).toBe(1)
    expect(first.nextTokenIdValue()).toBe(2)
    const second = new Store(config.dataDir)
    expect(second.nextTokenIdValue()).toBe(3)
  })

  it('consumes each payment tx hash exactly once, across restarts', () => {
    const config = testConfig()
    const first = new Store(config.dataDir)
    expect(first.consumePayment('0x' + 'ab'.repeat(32))).toBe(true)
    expect(first.consumePayment('0x' + 'ab'.repeat(32))).toBe(false)
    const second = new Store(config.dataDir)
    expect(second.consumePayment('0x' + 'AB'.repeat(32))).toBe(false)
  })

  it('persists an identity-bound payment session and returns it idempotently', () => {
    const config = testConfig()
    const txHash = '0x' + 'cd'.repeat(32)
    const identity = {
      player: '0x' + 'ef'.repeat(20),
      paymentId: '0x' + '12'.repeat(32),
    }
    const input = {
      txHash,
      ...identity,
      buildHash: 'build-a',
      ttlMs: 60_000,
    }
    const first = new Store(config.dataDir)
    expect(first.getOrCreatePaymentSession(input)).toEqual({
      ok: false,
      reason: 'payment not consumed',
    })
    expect(first.consumePayment(txHash, identity)).toBe(true)

    const created = first.getOrCreatePaymentSession(input)
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('expected a payment session')
    expect(created.created).toBe(true)
    expect(created.session.player).toBe(identity.player.toLowerCase())
    expect(created.session.paymentId).toBe(identity.paymentId.toLowerCase())

    const repeated = first.getOrCreatePaymentSession(input)
    expect(repeated).toEqual({ ok: true, created: false, session: created.session })

    const afterRestart = new Store(config.dataDir)
    expect(afterRestart.getPaymentSession(txHash, identity)).toEqual(created.session)
    expect(afterRestart.getOrCreatePaymentSession(input)).toEqual({
      ok: true,
      created: false,
      session: created.session,
    })
    expect(afterRestart.consumePaymentSession(created.session.sessionId, identity.player)).toBe(
      true,
    )
    const finalStore = new Store(config.dataDir)
    expect(finalStore.findPaymentSession(created.session.sessionId)?.consumed).toBe(true)
    expect(finalStore.getOrCreatePaymentSession(input)).toEqual({
      ok: true,
      created: false,
      session: { ...created.session, consumed: true },
    })
    expect(finalStore.consumePaymentSession(created.session.sessionId, identity.player)).toBe(false)
  })

  it('rejects recovery for a mismatched identity or legacy hash-only payment', () => {
    const config = testConfig()
    const first = new Store(config.dataDir)
    const txHash = '0x' + 'de'.repeat(32)
    const identity = {
      player: '0x' + 'ab'.repeat(20),
      paymentId: '0x' + '34'.repeat(32),
    }
    first.consumePayment(txHash, identity)
    expect(
      first.getOrCreatePaymentSession({
        txHash,
        player: '0x' + 'cd'.repeat(20),
        paymentId: identity.paymentId,
        buildHash: 'build-a',
        ttlMs: 60_000,
      }),
    ).toEqual({ ok: false, reason: 'payment identity mismatch' })

    const legacyTx = '0x' + 'aa'.repeat(32)
    first.consumePayment(legacyTx)
    expect(
      first.getOrCreatePaymentSession({
        txHash: legacyTx,
        ...identity,
        buildHash: 'build-a',
        ttlMs: 60_000,
      }),
    ).toEqual({ ok: false, reason: 'payment identity unavailable' })
  })

  it('persists attestations and status updates as append-only lines', () => {
    const config = testConfig()
    const first = new Store(config.dataDir)
    first.upsertAttestation(record(1, 'queued'))
    first.upsertAttestation(record(1, 'minted'))
    first.upsertAttestation(record(2, 'delayed'))
    const second = new Store(config.dataDir)
    expect(second.getAttestation(1)?.status).toBe('minted')
    expect(second.listAttestations().map((r) => r.tokenId)).toEqual([1, 2])
    expect(second.pendingMints().map((r) => r.tokenId)).toEqual([2])
  })

  it('requeues only terminal delayed mints without a submitted transaction', () => {
    const config = testConfig()
    const store = new Store(config.dataDir)
    const delayed = { ...record(3, 'delayed'), attempts: 5 }
    store.upsertAttestation(delayed)
    expect(store.requeueMint(3)).toBe(true)
    expect(store.getAttestation(3)?.status).toBe('queued')
    expect(store.getAttestation(3)?.attempts).toBe(0)
    expect(store.requeueMint(3)).toBe(false)
  })

  it('builds a verifiable SHA-256 hash chain across appends and reloads', () => {
    const config = testConfig()
    const first = new Store(config.dataDir)
    first.nextTokenIdValue()
    first.consumePayment('0x' + 'cd'.repeat(32))
    first.upsertAttestation(record(1, 'queued'))
    first.upsertAttestation(record(1, 'minted'))
    expect(first.integrity()).toBe('ok')
    // Chain fields are on disk...
    const raw = readFileSync(join(config.dataDir, 'attestations.jsonl'), 'utf8')
    expect(raw).toContain('_hash')
    expect(raw).toContain('_prev')
    // ...and a reload verifies them.
    const second = new Store(config.dataDir)
    expect(second.integrity()).toBe('ok')
    expect(second.getAttestation(1)?.status).toBe('minted')
  })

  it('detects a tampered attestation line on reload', () => {
    const config = testConfig()
    const first = new Store(config.dataDir)
    first.upsertAttestation(record(1, 'queued'))
    const file = join(config.dataDir, 'attestations.jsonl')
    const tampered = readFileSync(file, 'utf8').replace('"score":85', '"score":99')
    writeFileSync(file, tampered)
    const second = new Store(config.dataDir)
    expect(second.integrity()).toBe('broken')
    // The store still serves the (corrupted) data - broken is reported, not hidden.
    expect(second.getAttestation(1)?.score).toBe(99)
  })

  it('detects an unhashed append after the hash chain has started', () => {
    const config = testConfig()
    const first = new Store(config.dataDir)
    first.upsertAttestation(record(1, 'queued'))
    writeFileSync(
      join(config.dataDir, 'attestations.jsonl'),
      JSON.stringify(record(2, 'queued')) + '\n',
      { flag: 'a' },
    )
    const second = new Store(config.dataDir)
    expect(second.integrity()).toBe('broken')
    expect(second.getAttestation(2)?.tokenId).toBe(2)
  })

  it('loads legacy pre-chain lines as a trusted baseline', () => {
    const config = testConfig()
    mkdirSync(config.dataDir, { recursive: true })
    const legacy = JSON.stringify({ tokenId: 7, assignedAt: new Date().toISOString() })
    writeFileSync(join(config.dataDir, 'token-ids.jsonl'), legacy + '\n')
    const store = new Store(config.dataDir)
    expect(store.integrity()).toBe('ok')
    expect(store.nextTokenIdValue()).toBe(8)
  })
})
