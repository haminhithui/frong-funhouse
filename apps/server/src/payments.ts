import { createPublicClient, decodeEventLog, http, parseAbi } from 'viem'
import type { Hex } from 'viem'
import type { ServerConfig } from './config'
import { chainFor } from './chain'
import type { PaymentSessionInput, PaymentSessionResult, Store } from './store'

export const ENTRY_ABI = parseAbi([
  'event Paid(address indexed player, bytes32 indexed paymentId, uint256 amount)',
  'function price() view returns (uint256)',
])
export const ERC20_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

export interface PaymentLog {
  address: string
  data: string
  topics: string[]
}

export interface PaymentReceipt {
  status: 'success' | 'reverted'
  blockNumber: bigint
  to: string | null
  logs: readonly PaymentLog[]
}

/**
 * Narrow chain surface used by payment validation and the live-price read.
 * Production uses a viem public client; tests inject a fake (no network, no
 * credentials). config.feeAmount is deliberately NOT part of this surface:
 * it is a test/fallback value only and is never trusted at payment time.
 */
export interface PaymentClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<PaymentReceipt>
  getBlockNumber(): Promise<bigint>
  readPrice(address: Hex, blockNumber?: bigint): Promise<bigint>
}

export function createPaymentClient(config: ServerConfig): PaymentClient {
  const client = createPublicClient({
    chain: chainFor(config),
    transport: http(config.rpcUrl, { timeout: 15_000 }),
  })
  return {
    getTransactionReceipt: (args) => client.getTransactionReceipt(args) as Promise<PaymentReceipt>,
    getBlockNumber: () => client.getBlockNumber(),
    readPrice: (address, blockNumber) =>
      client.readContract({
        address,
        abi: ENTRY_ABI,
        functionName: 'price',
        blockNumber,
      }) as Promise<bigint>,
  }
}

export type PaymentResult =
  { ok: true; blockNumber: bigint } | { ok: false; reason: string; retryable?: boolean }

function isRetryableChainError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (typeof current === 'object' && current !== null) {
      const name = 'name' in current ? String((current as { name?: unknown }).name ?? '') : ''
      if (
        name.includes('HttpRequest') ||
        name.includes('Timeout') ||
        name.includes('Network') ||
        name.includes('Socket') ||
        name.includes('Rpc')
      ) {
        return true
      }
      current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined
    } else {
      break
    }
  }
  return false
}

/**
 * Recovery primitive for the /api/session parent route. Call this after chain
 * validation succeeds, or after a prior "payment already used" response: the
 * Store returns the original durable session when one exists and creates the
 * binding exactly once when validation consumed the payment before a crash.
 */
export function recoverPaymentSession(
  store: Store,
  input: PaymentSessionInput,
): PaymentSessionResult {
  return store.getOrCreatePaymentSession(input)
}

/**
 * Validates a payment against the chain: the receipt must exist, succeed, be
 * final, target the entry contract, and carry the Paid event with the expected
 * player/paymentId. The amount is validated two ways against the CHAIN (never
 * the stale config.feeAmount):
 *   (a) Paid.amount must equal the FRONG Transfer value in the same receipt;
 *   (b) Paid.amount must equal the on-chain FrongEntry.price read AT the
 *       receipt's block number (so a later operator price change never breaks
 *       a payment that was correct at the time it was made).
 * The tx hash is then marked consumed — one session per payment, ever.
 */
export async function validatePayment(
  config: ServerConfig,
  store: Store,
  txHash: string,
  expectedPlayer: string,
  expectedPaymentId: string,
  client: PaymentClient = createPaymentClient(config),
): Promise<PaymentResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'malformed tx hash' }

  let receipt: PaymentReceipt
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as Hex })
  } catch (error) {
    return isRetryableChainError(error)
      ? { ok: false, reason: 'payment RPC unavailable', retryable: true }
      : { ok: false, reason: 'transaction not found on chain' }
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'transaction reverted' }

  let head: bigint
  try {
    head = await client.getBlockNumber()
  } catch {
    return { ok: false, reason: 'payment RPC unavailable', retryable: true }
  }
  if (head - receipt.blockNumber < BigInt(config.confirmations)) {
    return { ok: false, reason: 'transaction not final yet' }
  }
  if (receipt.to?.toLowerCase() !== config.entry.toLowerCase()) {
    return { ok: false, reason: 'transaction does not target the entry contract' }
  }

  let paid: { player: string; paymentId: string; amount: bigint } | null = null
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.entry.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: ENTRY_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      })
      if (decoded.eventName === 'Paid') {
        paid = {
          player: String(decoded.args.player),
          paymentId: String(decoded.args.paymentId),
          amount: decoded.args.amount as bigint,
        }
      }
    } catch {
      // Not a Paid event on the entry contract.
    }
  }
  if (!paid) return { ok: false, reason: 'no Paid event on the entry contract' }
  if (paid.player.toLowerCase() !== expectedPlayer.toLowerCase()) {
    return { ok: false, reason: 'Paid event player does not match the verified wallet' }
  }
  if (paid.paymentId.toLowerCase() !== expectedPaymentId.toLowerCase()) {
    return { ok: false, reason: 'payment id mismatch' }
  }

  // (a) The Paid amount must equal the FRONG Transfer value in the same receipt.
  let transferValue: bigint | null = null
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.frong.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: ERC20_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      })
      if (decoded.eventName === 'Transfer') {
        const args = decoded.args as { from: string; to: string; value: bigint }
        if (
          args.from.toLowerCase() === expectedPlayer.toLowerCase() &&
          args.to.toLowerCase() === config.entry.toLowerCase()
        ) {
          transferValue = args.value
        }
      }
    } catch {
      // Not a Transfer event on the FRONG contract.
    }
  }
  if (transferValue === null) {
    return { ok: false, reason: 'no FRONG transfer into the entry contract' }
  }
  if (paid.amount !== transferValue) {
    return { ok: false, reason: 'Paid amount does not match the FRONG transfer value' }
  }

  // (b) The Paid amount must equal the on-chain price AT the receipt's block.
  let chainPrice: bigint
  try {
    chainPrice = await client.readPrice(config.entry as Hex, receipt.blockNumber)
  } catch {
    return { ok: false, reason: 'could not read the on-chain price', retryable: true }
  }
  if (paid.amount !== chainPrice) {
    return { ok: false, reason: 'paid amount does not match the on-chain price' }
  }

  if (
    !store.consumePayment(txHash, {
      player: expectedPlayer,
      paymentId: expectedPaymentId,
    })
  ) {
    return { ok: false, reason: 'payment already used' }
  }

  return { ok: true, blockNumber: receipt.blockNumber }
}

const PRICE_CACHE_TTL_MS = 30_000
const priceCache = new Map<string, { price: bigint; fetchedAt: number }>()

export type LivePriceResult = { ok: true; price: bigint } | { ok: false; reason: string }

/**
 * Reads the LIVE on-chain entry price, cached for a short window (~30s). On an
 * RPC failure this returns an error — callers must surface a 503, never fall
 * back to the stale config.feeAmount.
 */
export async function readLivePrice(
  config: ServerConfig,
  client: PaymentClient = createPaymentClient(config),
): Promise<LivePriceResult> {
  const key = config.chainId + ':' + config.rpcUrl + ':' + config.entry
  const now = Date.now()
  const cached = priceCache.get(key)
  if (cached && now - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
    return { ok: true, price: cached.price }
  }
  let price: bigint
  try {
    price = await client.readPrice(config.entry as Hex)
  } catch {
    return { ok: false, reason: 'could not read the on-chain price' }
  }
  priceCache.set(key, { price, fetchedAt: now })
  return { ok: true, price }
}
