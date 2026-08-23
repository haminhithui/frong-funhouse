import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import type { Account, Hex } from 'viem'
import type { ServerConfig } from './config'
import { chainFor } from './chain'
import type { AttestationRecord, Store } from './store'
import { createPinner, type MetadataPinner, type PinnedMetadata } from './pinner'
import { createSignerSafe, type MinterSigner } from './signer'
import type { ChainAttestation } from './rarity'

const TROPHY_ABI = parseAbi([
  'function mint(address to, uint256 tokenId, (uint8 tier, uint16 score, uint8 fliesCaught, bytes32 seedCommitment, bytes32 inputLogHash, uint256 timestamp, bytes32 buildHash) attestation, string tokenURI_)',
  'function ownerOf(uint256 tokenId) view returns (address)',
])

const POLL_MS = 2_000
export const MAX_MINT_ATTEMPTS = 5
const PENDING_TX_GRACE_MS = 5 * 60 * 1_000

type Receipt = { status?: string }

/** Narrow client seams keep the real viem clients injectable in unit tests. */
export interface MintPublicClient {
  readContract(args: {
    address: Hex
    abi: typeof TROPHY_ABI
    functionName: 'ownerOf'
    args: readonly [bigint]
  }): Promise<Hex>
  getTransactionReceipt?(args: { hash: Hex }): Promise<Receipt>
  waitForTransactionReceipt(args: { hash: Hex; confirmations?: number }): Promise<Receipt>
}

export interface MintWalletClient {
  writeContract(args: {
    address: Hex
    abi: typeof TROPHY_ABI
    functionName: 'mint'
    args: readonly [Hex, bigint, ChainAttestation, string]
  }): Promise<Hex>
}

export interface MintClientFactory {
  createPublicClient(config: ServerConfig): MintPublicClient
  createWalletClient(config: ServerConfig, account: Account): MintWalletClient
}

const defaultClientFactory: MintClientFactory = {
  createPublicClient(config) {
    return createPublicClient({
      chain: chainFor(config),
      transport: http(config.rpcUrl),
    }) as unknown as MintPublicClient
  },
  createWalletClient(config, account) {
    return createWalletClient({
      chain: chainFor(config),
      transport: http(config.rpcUrl),
      account,
    }) as unknown as MintWalletClient
  },
}

export type OwnerLookupClassification = 'token-not-found' | 'rpc-outage'

function errorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : null
}

function errorCause(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('cause' in error)) return null
  return (error as { cause?: unknown }).cause ?? null
}

/**
 * viem wraps an absent ERC-721 token as ContractFunctionExecutionError whose
 * cause is ContractFunctionRevertedError. Transport failures use request,
 * socket, or timeout errors instead. Unknown failures stay fail-closed as an
 * RPC/chain failure rather than being mistaken for a missing token.
 */
export function classifyOwnerLookupError(error: unknown): OwnerLookupClassification {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const name = errorName(current)
    if (name === 'ContractFunctionRevertedError') return 'token-not-found'
    current = errorCause(current)
  }
  return 'rpc-outage'
}

function isReceiptNotFound(error: unknown): boolean {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const name = errorName(current)
    if (name === 'TransactionReceiptNotFoundError' || name === 'TransactionNotFoundError') {
      return true
    }
    current = errorCause(current)
  }
  return false
}

function cidForUri(uri: string): string {
  return uri.startsWith('ipfs://') ? uri.slice('ipfs://'.length) : 'persisted:' + uri
}

type PriorTransactionState = 'none' | 'pending' | 'reverted' | 'rpc-outage' | 'success-not-visible'

/**
 * Mint worker: every persisted update is derived from the latest Store record
 * and appended as a new state transition. A pin is persisted before a mint
 * transaction is sent, so a restart can reuse it without repinning. The
 * existing `delayed` status is terminal when attempts reaches the exported
 * bound; an operator can recover it by explicitly requeueing the record with
 * a new attempt budget.
 */
export class MintWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly config: ServerConfig,
    private readonly store: Store,
    private readonly pinner: MetadataPinner = createPinner(config),
    private readonly signer: MinterSigner = createSignerSafe(config).signer,
    private readonly clients: MintClientFactory = defaultClientFactory,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.pump(), POLL_MS)
    void this.pump()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      if (this.store.integrity() === 'broken') {
        // The append-only journal is the source of truth for attestations,
        // token ids, and metadata. Never mint from a store whose audit chain
        // has been tampered with; require an operator restore/investigation.
        console.error('[mint] store audit chain is broken; minting is paused')
        return
      }
      for (const record of this.store.pendingMints()) {
        await this.process(record)
      }
    } finally {
      this.running = false
    }
  }

  private transition(
    record: AttestationRecord,
    patch: Partial<AttestationRecord>,
  ): AttestationRecord | null {
    const current = this.store.getAttestation(record.tokenId)
    if (!current) return null
    const next: AttestationRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    this.store.upsertAttestation(next)
    return next
  }

  private delay(record: AttestationRecord, reason: string, countAttempt: boolean): void {
    const current = this.store.getAttestation(record.tokenId)
    if (!current) return
    const attempts = countAttempt
      ? Math.min(MAX_MINT_ATTEMPTS, current.attempts + 1)
      : current.attempts
    const terminal = attempts >= MAX_MINT_ATTEMPTS
    this.transition(current, { status: 'delayed', attempts })
    console.error(
      '[mint] token',
      current.tokenId,
      'delayed:',
      reason,
      '(' +
        attempts +
        '/' +
        MAX_MINT_ATTEMPTS +
        (terminal ? '; operator requeue required' : '') +
        ')',
    )
  }

  private async priorTransactionState(
    publicClient: MintPublicClient,
    record: AttestationRecord,
  ): Promise<PriorTransactionState> {
    if (!record.txHash || !publicClient.getTransactionReceipt) return 'none'
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: record.txHash as Hex })
      if (receipt.status === 'success') return 'success-not-visible'
      if (receipt.status === 'reverted') return 'reverted'
      return 'pending'
    } catch (error) {
      if (isReceiptNotFound(error)) {
        const updatedAt = Date.parse(record.updatedAt)
        if (Number.isFinite(updatedAt) && Date.now() - updatedAt < PENDING_TX_GRACE_MS) {
          return 'pending'
        }
        return 'reverted'
      }
      return 'rpc-outage'
    }
  }

  private async resolvePinned(record: AttestationRecord): Promise<PinnedMetadata> {
    if (record.uri) {
      if (!this.pinner.isPinned) {
        // A URI written by this worker is already the immutable URI used by
        // the transaction. Custom pinners without an inspection seam must
        // preserve it rather than silently replacing it on retry.
        return { uri: record.uri, cid: cidForUri(record.uri) }
      }
      if (await this.pinner.isPinned(record.tokenId, record.uri, record.metadata)) {
        return { uri: record.uri, cid: cidForUri(record.uri) }
      }
    }
    return this.pinner.pinMetadata(record.tokenId, record.metadata)
  }

  private async process(inputRecord: AttestationRecord): Promise<void> {
    let record = this.store.getAttestation(inputRecord.tokenId)
    if (!record || record.status === 'minted' || record.status === 'rejected') return
    if (record.attempts >= MAX_MINT_ATTEMPTS && !record.txHash) {
      console.warn('[mint] token', record.tokenId, 'is terminal delayed; operator requeue required')
      return
    }

    // A queued record without a signer stays queued, preserving the existing
    // fail-closed operational behavior. A prior submitted attempt is still
    // checked on-chain so a restart can recover it even if signing is now off.
    let account: Account | null = null
    try {
      account = await this.signer.getAccount()
    } catch (error) {
      console.error('[mint] signer unavailable for token', record.tokenId, ':', String(error))
      return
    }
    const mustRecoverPriorAttempt = Boolean(record.txHash)
    if (!account && !mustRecoverPriorAttempt) {
      console.warn('[mint] no minter signer configured; token', record.tokenId, 'stays queued')
      return
    }

    let publicClient: MintPublicClient
    try {
      publicClient = this.clients.createPublicClient(this.config)
    } catch (error) {
      this.delay(record, 'public client creation failed: ' + String(error), true)
      return
    }

    // Idempotency is intentionally before pinning. An already-minted token
    // must be recovered without touching Pinata or the local filesystem.
    let owner: Hex
    try {
      owner = await publicClient.readContract({
        address: this.config.trophy as Hex,
        abi: TROPHY_ABI,
        functionName: 'ownerOf',
        args: [BigInt(record.tokenId)],
      })
    } catch (error) {
      if (classifyOwnerLookupError(error) === 'token-not-found') {
        owner = '' as Hex
      } else {
        this.delay(record, 'ownerOf RPC/chain lookup failed: ' + String(error), true)
        return
      }
    }

    if (owner && !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
      this.delay(record, 'ownerOf returned an invalid owner address', true)
      return
    }

    if (owner) {
      if (owner.toLowerCase() === record.player.toLowerCase()) {
        this.transition(record, { status: 'minted' })
        console.log('[mint] token', record.tokenId, 'already on-chain for the right owner')
        return
      }
      this.transition(record, { status: 'rejected' })
      console.error(
        '[mint] token',
        record.tokenId,
        'already exists on-chain owned by',
        owner,
        '- record rejected (server token counter diverged)',
      )
      return
    }

    const prior = await this.priorTransactionState(publicClient, record)
    if (prior === 'rpc-outage') {
      this.delay(record, 'prior mint transaction receipt lookup failed', true)
      return
    }
    if (prior === 'pending' || prior === 'success-not-visible') {
      // Never submit a second transaction while the previous hash may still
      // settle. The next pump will perform ownerOf again and recover success.
      console.warn(
        '[mint] token',
        record.tokenId,
        'has a prior transaction; waiting for chain state',
      )
      return
    }
    if (prior === 'reverted') {
      record = this.transition(record, { status: 'delayed', txHash: null }) ?? record
    }

    if (record.attempts >= MAX_MINT_ATTEMPTS) {
      console.warn('[mint] token', record.tokenId, 'is terminal delayed; operator requeue required')
      return
    }
    if (!account) {
      console.warn('[mint] token', record.tokenId, 'cannot retry without a signer')
      return
    }

    let pinned: PinnedMetadata
    try {
      pinned = await this.resolvePinned(record)
    } catch (error) {
      this.delay(record, 'metadata pin failed: ' + String(error), true)
      return
    }

    // Persist the immutable URI before attempting the transaction. If the
    // process dies after pinning, restart recovery reuses this exact URI.
    record = this.transition(record, { uri: pinned.uri }) ?? record
    const attempts = record.attempts + 1
    const attestation: ChainAttestation = {
      tier: record.tier,
      score: record.score,
      fliesCaught: record.fliesCaught,
      seedCommitment: ('0x' + record.seedCommitment) as Hex,
      inputLogHash: ('0x' + record.inputLogHash) as Hex,
      timestamp: BigInt(record.timestamp),
      buildHash: ('0x' + record.buildHash) as Hex,
    }
    record =
      this.transition(record, {
        status: 'minting',
        attempts,
        txHash: null,
        uri: pinned.uri,
      }) ?? record

    let wallet: MintWalletClient
    try {
      wallet = this.clients.createWalletClient(this.config, account)
    } catch (error) {
      this.delay(record, 'wallet client creation failed: ' + String(error), false)
      return
    }

    try {
      const hash = await wallet.writeContract({
        address: this.config.trophy as Hex,
        abi: TROPHY_ABI,
        functionName: 'mint',
        args: [record.player as Hex, BigInt(record.tokenId), attestation, pinned.uri],
      })
      // Persist the hash immediately. A crash during receipt polling can then
      // be recovered by ownerOf/receipt idempotency on the next process.
      record = this.transition(record, { txHash: hash }) ?? record
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: this.config.confirmations,
      })
      if (receipt.status && receipt.status !== 'success') {
        throw new Error('mint transaction receipt status: ' + receipt.status)
      }
      this.transition(record, { status: 'minted', txHash: hash, uri: pinned.uri })
      console.log('[mint] token', record.tokenId, 'minted in', hash)
    } catch (error) {
      console.error('[mint] token', record.tokenId, 'failed:', String(error))
      // attempts was consumed when the minting transition was persisted;
      // preserve it and the pinned URI instead of rebuilding from stale input.
      this.delay(record, 'mint transaction failed: ' + String(error), false)
    }
  }
}
