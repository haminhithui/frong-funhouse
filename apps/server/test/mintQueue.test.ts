import { describe, expect, it } from 'vitest'
import { MintWorker } from '../src/mintQueue'
import { Store } from '../src/store'
import type { AttestationRecord } from '../src/store'
import { FailingPinner } from '../src/pinner'
import { EnvKeySigner } from '../src/signer'
import { testConfig } from './config'

function queuedRecord(tokenId: number): AttestationRecord {
  return {
    tokenId,
    player: '0x' + 'ab'.repeat(20),
    sessionId: 'session-' + tokenId,
    tier: 0,
    tierName: 'Tadpole',
    score: 20,
    fliesCaught: 10,
    seedCommitment: 'a'.repeat(64),
    inputLogHash: 'b'.repeat(64),
    buildHash: 'c'.repeat(64),
    timestamp: 1_700_000_000,
    uri: '',
    metadata: {
      name: 'FRONG Catch Trophy #' + tokenId,
      description: 'x',
      image: 'x',
      attributes: [],
    },
    status: 'queued',
    txHash: null,
    attempts: 0,
    updatedAt: new Date().toISOString(),
  }
}

describe('mint queue seams (dependency injection)', () => {
  it('keeps records queued when no signer is configured', async () => {
    const config = testConfig()
    const store = new Store(config.dataDir)
    store.upsertAttestation(queuedRecord(1))
    const worker = new MintWorker(config, store)
    await (worker as unknown as { pump(): Promise<void> }).pump()
    expect(store.getAttestation(1)?.status).toBe('queued')
  })

  it('never mints when pinning fails: record stays delayed, no fake CID', async () => {
    const config = testConfig({ minterKey: '0x' + 'ab'.repeat(32) })
    const store = new Store(config.dataDir)
    store.upsertAttestation(queuedRecord(2))
    const worker = new MintWorker(
      config,
      store,
      new FailingPinner(),
      new EnvKeySigner(config.minterKey),
    )
    await (worker as unknown as { pump(): Promise<void> }).pump()
    const after = store.getAttestation(2)
    expect(after?.status).toBe('delayed')
    expect(after?.attempts).toBe(1)
    // The URI was never replaced with a placeholder.
    expect(after?.uri).toBe('')
  })
})
