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
