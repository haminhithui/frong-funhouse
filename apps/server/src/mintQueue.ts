import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import type { Hex } from 'viem'
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
const MAX_ATTEMPTS = 5

/**
 * Mint worker: pins metadata FIRST (fail closed - a failed pin means NO mint,
 * never a fake CID), then sends the real mint transaction through the
 * injected signer (KMS in production, local hot key in dev/testnet).
 * Retries with backoff; never double-mints (token id is checked on-chain
 * first). Without a signer, records stay queued and the server logs why -
 * minting is disabled, not faked.
 */
export class MintWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly config: ServerConfig,
    private readonly store: Store,
    private readonly pinner: MetadataPinner = createPinner(config),
    private readonly signer: MinterSigner = createSignerSafe(config).signer,
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
      for (const record of this.store.pendingMints()) {
        await this.process(record)
      }
    } finally {
      this.running = false
    }
  }

  private async process(record: AttestationRecord): Promise<void> {
    if (record.attempts >= MAX_ATTEMPTS) {
      // Kept delayed; retries resume only after operator intervention.
      return
    }
    const account = await this.signer.getAccount()
    if (!account) {
      console.warn('[mint] no minter signer configured; token', record.tokenId, 'stays queued')
      return
    }

    // Pin FIRST: no pin, no mint (fail closed). A pin failure keeps the
    // record delayed and NEVER mints with a placeholder URI.
    let pinned: PinnedMetadata
    try {
      pinned = await this.pinner.pinMetadata(record.tokenId, record.metadata)
    } catch (error) {
      console.error('[mint] pin failed for token', record.tokenId, ':', String(error))
      this.store.upsertAttestation({
        ...record,
        status: 'delayed',
        attempts: record.attempts + 1,
        updatedAt: new Date().toISOString(),
      })
      return
    }

    const publicClient = createPublicClient({
      chain: chainFor(this.config),
      transport: http(this.config.rpcUrl),
    })

    // Idempotency: if the token already exists on-chain, only claim success
    // when the on-chain owner is the player this record was minted for.
    try {
      const owner = await publicClient.readContract({
        address: this.config.trophy as Hex,
        abi: TROPHY_ABI,
        functionName: 'ownerOf',
        args: [BigInt(record.tokenId)],
      })
      if (owner.toLowerCase() === record.player.toLowerCase()) {
        this.store.upsertAttestation({
          ...record,
          status: 'minted',
          updatedAt: new Date().toISOString(),
        })
        console.log('[mint] token', record.tokenId, 'already on-chain for the right owner')
        return
      }
      this.store.upsertAttestation({
        ...record,
        status: 'rejected',
        updatedAt: new Date().toISOString(),
      })
      console.error(
        '[mint] token',
        record.tokenId,
        'already exists on-chain owned by',
        owner,
        '- record rejected (server token counter diverged)',
      )
      return
    } catch {
      // Not minted yet - proceed.
    }

    const attestation: ChainAttestation = {
      tier: record.tier,
      score: record.score,
      fliesCaught: record.fliesCaught,
      seedCommitment: ('0x' + record.seedCommitment) as Hex,
      inputLogHash: ('0x' + record.inputLogHash) as Hex,
      timestamp: BigInt(record.timestamp),
      buildHash: ('0x' + record.buildHash) as Hex,
    }

    this.store.upsertAttestation({
      ...record,
      uri: pinned.uri,
      status: 'minting',
      attempts: record.attempts + 1,
      updatedAt: new Date().toISOString(),
    })

    const wallet = createWalletClient({
      chain: chainFor(this.config),
      transport: http(this.config.rpcUrl),
      account,
    })

    try {
      const hash = await wallet.writeContract({
        address: this.config.trophy as Hex,
        abi: TROPHY_ABI,
        functionName: 'mint',
        args: [record.player as Hex, BigInt(record.tokenId), attestation, pinned.uri],
      })
      await publicClient.waitForTransactionReceipt({ hash })
      this.store.upsertAttestation({
        ...record,
        status: 'minted',
        txHash: hash,
        updatedAt: new Date().toISOString(),
      })
      console.log('[mint] token', record.tokenId, 'minted in', hash)
    } catch (error) {
      console.error('[mint] token', record.tokenId, 'failed:', String(error))
      this.store.upsertAttestation({
        ...record,
        status: 'delayed',
        updatedAt: new Date().toISOString(),
      })
    }
  }
}
