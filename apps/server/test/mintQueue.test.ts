import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { MintWorker, MAX_MINT_ATTEMPTS, classifyOwnerLookupError } from '../src/mintQueue'
import type { MintClientFactory } from '../src/mintQueue'
import { Store } from '../src/store'
import type { AttestationRecord } from '../src/store'
import { FailingPinner, type MetadataPinner, type PinnedMetadata } from '../src/pinner'
import { EnvKeySigner } from '../src/signer'
import { testConfig } from './config'

const PLAYER = ('0x' + 'ab'.repeat(20)) as Hex
const TX_HASH = ('0x' + '12'.repeat(32)) as Hex

function queuedRecord(
  tokenId: number,
  overrides: Partial<AttestationRecord> = {},
): AttestationRecord {
  return {
    tokenId,
    player: PLAYER,
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
      description: 'Replay-verified run.',
      image: 'https://metadata.example/assets/tiers/tadpole.svg',
      attributes: [],
    },
    status: 'queued',
    txHash: null,
    attempts: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function namedError(name: string, message: string): Error {
  const error = new Error(message)
  Object.defineProperty(error, 'name', { value: name })
  return error
}

class RecordingPinner implements MetadataPinner {
  calls = 0
  reuseChecks = 0
  readonly pinned: PinnedMetadata = { uri: 'ipfs://bafy-test-metadata', cid: 'bafy-test-metadata' }

  async pinMetadata(): Promise<PinnedMetadata> {
    this.calls += 1
    return this.pinned
  }

  async isPinned(_tokenId: number, uri: string): Promise<boolean> {
    this.reuseChecks += 1
    return uri === this.pinned.uri
  }
}

function clientFactory(options: {
  owner?: Hex
  readError?: unknown
  writeError?: Error
  receiptStatus?: string
}): MintClientFactory & { readonly writes: number } {
  let writes = 0
  return {
    get writes() {
      return writes
    },
    createPublicClient: () => ({
      readContract: async () => {
        if (options.readError) throw options.readError
        if (options.owner) return options.owner
        throw namedError('ContractFunctionRevertedError', 'token does not exist')
      },
      getTransactionReceipt: async () => ({ status: options.receiptStatus ?? 'reverted' }),
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    }),
    createWalletClient: () => ({
      writeContract: async () => {
        writes += 1
        if (options.writeError) throw options.writeError
        return TX_HASH
      },
    }),
  }
}

async function pump(worker: MintWorker): Promise<void> {
  await (worker as unknown as { pump(): Promise<void> }).pump()
}

describe('mint queue recovery and dependency seams', () => {
  it('classifies an ownerOf revert as token-not-found but transport failures as RPC outages', () => {
    expect(
      classifyOwnerLookupError(namedError('ContractFunctionRevertedError', 'missing token')),
    ).toBe('token-not-found')
    expect(classifyOwnerLookupError(namedError('HttpRequestError', 'connection refused'))).toBe(
      'rpc-outage',
    )
  })

  it('keeps records queued when no signer is configured', async () => {
    const config = testConfig()
    const store = new Store(config.dataDir)
    store.upsertAttestation(queuedRecord(1))
    const worker = new MintWorker(config, store)
    await pump(worker)
    expect(store.getAttestation(1)?.status).toBe('queued')
  })

  it('never mints when pinning fails: record stays delayed, no fake CID', async () => {
    const config = testConfig({ minterKey: '0x' + 'ab'.repeat(32) })
    const store = new Store(config.dataDir)
    store.upsertAttestation(queuedRecord(2))
    const clients = clientFactory({})
    const worker = new MintWorker(
      config,
      store,
      new FailingPinner(),
      new EnvKeySigner(config.minterKey),
      clients,
    )
    await pump(worker)
    const after = store.getAttestation(2)
    expect(after?.status).toBe('delayed')
    expect(after?.attempts).toBe(1)
    expect(after?.uri).toBe('')
    expect(clients.writes).toBe(0)
  })

  it('pauses minting when the persisted audit chain is broken', async () => {
    const config = testConfig({ minterKey: '0x' + 'ab'.repeat(32) })
    const store = new Store(config.dataDir)
    store.upsertAttestation(queuedRecord(20))
    const file = join(config.dataDir, 'attestations.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"score":20', '"score":21'))
    const restarted = new Store(config.dataDir)
    const pinner = new RecordingPinner()
    const clients = clientFactory({})
    const worker = new MintWorker(
      config,
      restarted,
      pinner,
      new EnvKeySigner(config.minterKey),
      clients,
    )
    await pump(worker)

    expect(restarted.integrity()).toBe('broken')
    expect(restarted.getAttestation(20)?.status).toBe('queued')
    expect(pinner.calls).toBe(0)
    expect(clients.writes).toBe(0)
  })

  it('bounds transaction failures and preserves one pinned URI through exhaustion', async () => {
    const config = testConfig({ minterKey: '0x' + 'ab'.repeat(32) })
    const store = new Store(config.dataDir)
    store.upsertAttestation(queuedRecord(3))
    const pinner = new RecordingPinner()
    const clients = clientFactory({ writeError: new Error('transaction rejected') })
    const worker = new MintWorker(
      config,
      store,
      pinner,
      new EnvKeySigner(config.minterKey),
      clients,
    )

    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS + 1; attempt += 1) await pump(worker)

    const after = store.getAttestation(3)
    expect(after?.status).toBe('delayed')
    expect(after?.attempts).toBe(MAX_MINT_ATTEMPTS)
    expect(after?.uri).toBe(pinner.pinned.uri)
    expect(pinner.calls).toBe(1)
    expect(pinner.reuseChecks).toBe(MAX_MINT_ATTEMPTS - 1)
    expect(clients.writes).toBe(MAX_MINT_ATTEMPTS)
  })

  it('persists the pinned URI and transaction hash on successful mint', async () => {
    const config = testConfig({ minterKey: '0x' + 'ab'.repeat(32) })
    const first = new Store(config.dataDir)
    first.upsertAttestation(queuedRecord(4))
    const pinner = new RecordingPinner()
    const worker = new MintWorker(
      config,
      first,
      pinner,
      new EnvKeySigner(config.minterKey),
      clientFactory({}),
    )
    await pump(worker)

    const after = first.getAttestation(4)
    expect(after?.status).toBe('minted')
    expect(after?.attempts).toBe(1)
    expect(after?.uri).toBe(pinner.pinned.uri)
    expect(after?.txHash).toBe(TX_HASH)

    const restarted = new Store(config.dataDir)
    expect(restarted.getAttestation(4)?.uri).toBe(pinner.pinned.uri)
    expect(restarted.getAttestation(4)?.status).toBe('minted')
  })

  it('recovers an already-minted token after restart before pinning or sending', async () => {
    const config = testConfig({ minterKey: '0x' + 'ab'.repeat(32) })
    const first = new Store(config.dataDir)
    first.upsertAttestation(
      queuedRecord(5, {
        status: 'minting',
        attempts: 2,
        uri: 'ipfs://bafy-already-minted',
        txHash: TX_HASH,
      }),
    )
    const restarted = new Store(config.dataDir)
    const pinner = new RecordingPinner()
    const clients = clientFactory({ owner: PLAYER })
    const worker = new MintWorker(
      config,
      restarted,
      pinner,
      new EnvKeySigner(config.minterKey),
      clients,
    )
    await pump(worker)

    const after = restarted.getAttestation(5)
    expect(after?.status).toBe('minted')
    expect(after?.attempts).toBe(2)
    expect(after?.uri).toBe('ipfs://bafy-already-minted')
    expect(pinner.calls).toBe(0)
    expect(clients.writes).toBe(0)
  })

  it('does not pin or mint during an RPC outage and records a bounded retry', async () => {
    const config = testConfig({ minterKey: '0x' + 'ab'.repeat(32) })
    const store = new Store(config.dataDir)
    store.upsertAttestation(queuedRecord(6))
    const pinner = new RecordingPinner()
    const clients = clientFactory({ readError: namedError('HttpRequestError', 'RPC offline') })
    const worker = new MintWorker(
      config,
      store,
      pinner,
      new EnvKeySigner(config.minterKey),
      clients,
    )
    await pump(worker)

    const after = store.getAttestation(6)
    expect(after?.status).toBe('delayed')
    expect(after?.attempts).toBe(1)
    expect(pinner.calls).toBe(0)
    expect(clients.writes).toBe(0)
  })
})
