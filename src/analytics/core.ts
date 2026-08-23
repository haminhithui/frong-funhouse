/**
 * Pure, dependency-free core for the FRONG fee/liquidity analytics pipeline.
 *
 * Everything here is derived from on-chain events on Robinhood Chain mainnet
 * (chain 4663). The FeeSplitter contract (0x7198C32a...) is unverified; its two
 * event types were identified empirically and cross-validated against the
 * verified recipient contracts (UERC20BeneficiaryVault, CompoundingClaimRecipient)
 * and the PoolManager ModifyLiquidity events:
 *
 * - FeesCollected(tokenId indexed, currency indexed, uint256 amount0, uint256 amount1)
 *   topic0 0x1df95d00... - per-position, per-claim totals: amount0 = ETH, amount1 = FRONG.
 * - FeesForwarded(recipient indexed, currency indexed, uint256 amount)
 *   topic0 0x8d6dc9dd... - per-recipient share of the open claim.
 *
 * Within a transaction the FeeSplitter emits FeesCollected rows followed by the
 * matching FeesForwarded rows, in log order (verified: 0 pairing mismatches
 * across the full history; the sum of forwards equals the collected totals,
 * modulo 1 wei rounding dust).
 */
import type {
  ArtifactTotals,
  ClaimPair,
  DailyAggregate,
  EventsCollections,
  FrEvent,
  FrEventKind,
  FrongAnalyticsArtifact,
  HourlyAggregate,
  RawLog,
  RecentEvent,
  SwapEvent,
} from './types'

// ---------------------------------------------------------------------------
// Verified chain facts (Robinhood mainnet 4663) - see discovery notes.
// ---------------------------------------------------------------------------

export const CHAIN_ID = 4663
export const CHAIN_NAME = 'Robinhood Chain mainnet'
export const EXPLORER_TX_URL_TEMPLATE = 'https://robinhoodchain.blockscout.com/tx/{tx}'
export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'

export const FRONG_ADDRESS = '0x6245e67affa44a23077f0ea7f981a8dc743a0c47'
export const POOL_ID = '0xacea8920877840033f0275c37f9b61550b5326917e948bcf8339714d96f9521a'
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
export const FEE_SPLITTER = '0x7198c32a497c09497e04c86cf8f77a244a9e4b8f'
export const BENEFICIARY_VAULT = '0x587d2fdddf14f6f84022b51e8c3a473eb88c4544'
export const BENEFICIARY_NFT_HOLDER = '0xef451b293ed8c61d20f7d13ef336a496f0cc2c26'
export const COMPOUNDING_RECIPIENT = '0x666da63451a502a323677c2ef5f763181358be9b'

export const POSITION_TOKEN_ID = 409801n
/** Position tick range at launch (tickSpacing 60 multiples). */
export const TICK_LOWER = -208980
export const TICK_UPPER = 198060

/** Static pool-key LP fee, hundredths of a bip: 2500 = 0.25%. Never a dynamic value. */
export const POOL_FEE_UNITS = 2500n
/** Protocol fee per direction, hundredths of a bip: 400 = 0.04% (paid to the protocol, not LPs). */
export const PROTOCOL_FEE_UNITS = 400n

/** CompoundingClaimRecipient.minLiquidityIncrease() - a claim threshold, never a fee %. */
export const MIN_LIQUIDITY_INCREASE = 100000000000000000000n

/** FRONG/ETH pool initialization + position 409801 creation block. */
export const LAUNCH_BLOCK = 23595790

export const TOPIC_FEES_COLLECTED =
  '0x1df95d0058852523ea13aa1809224af942bd446ce86d3e431bf193c2bec269f1'
export const TOPIC_FEES_FORWARDED =
  '0x8d6dc9ddf16486b9c0142a50ed03c92af9e6a98d91c3c6ea900ef44b3d602e3b'
export const TOPIC_AMOUNTS_RECEIVED =
  '0xd9eb4e5dde81c43cfba8f56d8acef16ad4a2740390f2a5dc337c1de7a178c6b1'
export const TOPIC_CLAIMED = '0xa13569eccad8e9d7eed1a66b1944fe2a6ff946072c636c0a8c5af0ac6c24be5b'
export const TOPIC_MODIFY_LIQUIDITY =
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'

/**
 * Fork Swap event (verified against the verified PoolManager ABI):
 * Swap(bytes32 id indexed, address sender indexed, int128 amount0, int128
 * amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee).
 * The trailing fee word is a RATE-like constant (observed 2899) whose exact
 * fork semantics are NOT pinned - swap fee amounts are therefore NOT derived
 * from it anywhere in this codebase.
 */
export const TOPIC_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'

/** Observed trailing Swap word - recorded for provenance, never used as an amount. */
export const SWAP_FEE_WORD_OBSERVED = 2899

export const SCHEMA_VERSION = 2

// ---------------------------------------------------------------------------
// Primitive decoding (ABI words, two's complement)
// ---------------------------------------------------------------------------

/** Sign-extend the low 24 bits of an ABI word to an int24. */
export function sign24(word: string): number {
  const low = word.slice(-6)
  let value = Number.parseInt(low, 16)
  if (value > 0x7fffff) value -= 0x1000000
  return value
}

/** Interpret an ABI word as an int256 and return it as a decimal string. */
export function sign256(word: string): string {
  const value = BigInt(word.startsWith('0x') ? word : '0x' + word)
  return (
    value > 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn
      ? value - (1n << 256n)
      : value
  ).toString()
}

/** Read the n-th 32-byte word of log data. Returns '' when out of range. */
export function dataWord(data: string, index: number): string {
  const body = data.startsWith('0x') ? data.slice(2) : data
  const word = body.slice(index * 64, index * 64 + 64)
  return word.length === 64 ? '0x' + word : ''
}

export function topicAddress(word: string): string {
  return word.length >= 40 ? '0x' + word.slice(-40) : word
}

export function hexToBigInt(value: string): bigint {
  return BigInt(value.startsWith('0x') ? value : '0x' + value)
}

export function bigIntToHex(value: bigint, padBits = 256): string {
  return '0x' + value.toString(16).padStart(padBits / 4, '0')
}

export const POSITION_ID_WORD = bigIntToHex(POSITION_TOKEN_ID)

// ---------------------------------------------------------------------------
// Event decoding
// ---------------------------------------------------------------------------

export interface DecodedModifyLiquidity {
  poolId: string
  sender: string
  tickLower: number
  tickUpper: number
  /** Decimal string; positive = add, negative = remove. */
  delta: string
  salt: string
}

export function decodeModifyLiquidity(log: RawLog): DecodedModifyLiquidity {
  return {
    poolId: log.topics[1] ?? '',
    sender: topicAddress(log.topics[2] ?? ''),
    tickLower: sign24(dataWord(log.data, 0)),
    tickUpper: sign24(dataWord(log.data, 1)),
    delta: sign256(dataWord(log.data, 2)),
    salt: dataWord(log.data, 3),
  }
}

/** FeesCollected(tokenId indexed, currency indexed, amount0, amount1). */
export function decodeFeesCollected(log: RawLog): {
  tokenId: string
  currency: string
  amount0: bigint
  amount1: bigint
} {
  return {
    tokenId: log.topics[1] ?? '',
    currency: topicAddress(log.topics[2] ?? ''),
    amount0: hexToBigInt(dataWord(log.data, 0)),
    amount1: hexToBigInt(dataWord(log.data, 1)),
  }
}

/** FeesForwarded(recipient indexed, currency indexed, amount). */
export function decodeFeesForwarded(log: RawLog): {
  recipient: string
  currency: string
  amount: bigint
} {
  return {
    recipient: topicAddress(log.topics[1] ?? ''),
    currency: topicAddress(log.topics[2] ?? ''),
    amount: hexToBigInt(dataWord(log.data, 0)),
  }
}

/** AmountsReceived(tokenId indexed, currency0Amount, currency1Amount). */
export function decodeAmountsReceived(log: RawLog): {
  tokenId: string
  currency0: bigint
  currency1: bigint
} {
  return {
    tokenId: log.topics[1] ?? '',
    currency0: hexToBigInt(dataWord(log.data, 0)),
    currency1: hexToBigInt(dataWord(log.data, 1)),
  }
}

/** Claimed(tokenId indexed, currency0Amount, currency1Amount, PoolKey). */
export function decodeClaimed(log: RawLog): {
  tokenId: string
  currency0: bigint
  currency1: bigint
} {
  return {
    tokenId: log.topics[1] ?? '',
    currency0: hexToBigInt(dataWord(log.data, 0)),
    currency1: hexToBigInt(dataWord(log.data, 1)),
  }
}

// ---------------------------------------------------------------------------
// FeeSplitter claim pairing (order-based walk per transaction)
// ---------------------------------------------------------------------------

const BENEFICIARY_VAULT_LOWER = BENEFICIARY_VAULT.toLowerCase()
const COMPOUNDING_RECIPIENT_LOWER = COMPOUNDING_RECIPIENT.toLowerCase()
const ZERO_ADDRESS = '0x' + '0'.repeat(40)
const FRONG_ADDRESS_LOWER = FRONG_ADDRESS.toLowerCase()

function sortLogs(logs: RawLog[]): RawLog[] {
  return [...logs].sort((a, b) => Number.parseInt(a.logIndex, 16) - Number.parseInt(b.logIndex, 16))
}

/**
 * Walk the FeeSplitter logs of each transaction in log order and pair every
 * FeesCollected row with the FeesForwarded rows that follow it (until the next
 * FeesCollected). The vault share and the compounding share must sum to the
 * collected totals per currency, modulo +/-1 wei rounding dust.
 */
export function pairFeeSplitterClaims(fsLogs: RawLog[]): ClaimPair[] {
  const byTx = new Map<string, RawLog[]>()
  for (const log of fsLogs) {
    const list = byTx.get(log.transactionHash)
    if (list) list.push(log)
    else byTx.set(log.transactionHash, [log])
  }

  const claims: ClaimPair[] = []
  for (const logs of byTx.values()) {
    let open: ClaimPair | null = null
    const close = () => {
      if (!open) return
      const ethOk =
        open.eth - open.vaultEth - open.compoundEth >= -1n &&
        open.eth - open.vaultEth - open.compoundEth <= 1n
      const frongOk =
        open.frong - open.vaultFrong - open.compoundFrong >= -1n &&
        open.frong - open.vaultFrong - open.compoundFrong <= 1n
      claims.push(ethOk && frongOk ? open : { ...open, pairingMismatch: true })
      open = null
    }
    for (const log of sortLogs(logs)) {
      const topic = log.topics[0]?.toLowerCase()
      if (topic === TOPIC_FEES_COLLECTED) {
        close()
        const decoded = decodeFeesCollected(log)
        open = {
          txHash: log.transactionHash,
          block: Number.parseInt(log.blockNumber, 16),
          tokenId: decoded.tokenId,
          eth: decoded.amount0,
          frong: decoded.amount1,
          vaultEth: 0n,
          vaultFrong: 0n,
          compoundEth: 0n,
          compoundFrong: 0n,
          feesCollected: log,
          forwards: [],
        }
        continue
      }
      if (topic === TOPIC_FEES_FORWARDED && open) {
        const decoded = decodeFeesForwarded(log)
        const recipient = decoded.recipient.toLowerCase()
        const currency = decoded.currency.toLowerCase()
        open.forwards.push(log)
        if (currency === ZERO_ADDRESS) {
          if (recipient === BENEFICIARY_VAULT_LOWER) open.vaultEth += decoded.amount
          else if (recipient === COMPOUNDING_RECIPIENT_LOWER) open.compoundEth += decoded.amount
        } else if (currency === FRONG_ADDRESS_LOWER) {
          if (recipient === BENEFICIARY_VAULT_LOWER) open.vaultFrong += decoded.amount
          else if (recipient === COMPOUNDING_RECIPIENT_LOWER) open.compoundFrong += decoded.amount
        }
      }
    }
    close()
  }

  claims.sort(
    (a, b) =>
      a.block - b.block ||
      Number.parseInt(a.feesCollected.logIndex, 16) - Number.parseInt(b.feesCollected.logIndex, 16),
  )
  return claims
}

// ---------------------------------------------------------------------------
// Position-scoped event building
// ---------------------------------------------------------------------------

export interface BlockTimestamps {
  get: (block: number) => number | undefined
}

export function buildPositionEvents(input: {
  claims: ClaimPair[]
  vaultLogs: RawLog[]
  compoundLogs: RawLog[]
  modifyLiquidityLogs: RawLog[]
  blockTimestamps: BlockTimestamps
  fromBlock: number
  toBlock: number
}): EventsCollections {
  const tsOf = (log: RawLog): number => {
    return input.blockTimestamps.get(Number.parseInt(log.blockNumber, 16)) ?? 0
  }
  const inRange = (log: RawLog): boolean => {
    const block = Number.parseInt(log.blockNumber, 16)
    return block > input.fromBlock && block <= input.toBlock
  }
  const events: EventsCollections = {
    feesCollected: [],
    feesForwardedVault: [],
    feesForwardedCompound: [],
    vaultAmountsReceived: [],
    vaultClaimed: [],
    compoundAmountsReceived: [],
    compoundClaimed: [],
    modifyLiquidity: [],
  }

  for (const claim of input.claims) {
    if (claim.tokenId.toLowerCase() !== POSITION_ID_WORD.toLowerCase()) continue
    if (!inRange(claim.feesCollected)) continue
    // Position 409801 pairs exactly (verified); skip only if that ever changes
    // so no misattributed forward leaks into the totals.
    if (claim.pairingMismatch) continue
    events.feesCollected.push({
      kind: 'feesCollected',
      block: claim.block,
      ts: tsOf(claim.feesCollected),
      txHash: claim.txHash,
      logIndex: Number.parseInt(claim.feesCollected.logIndex, 16),
      eth: claim.eth.toString(),
      frong: claim.frong.toString(),
    })
    for (const forward of claim.forwards) {
      if (!inRange(forward)) continue
      const decoded = decodeFeesForwarded(forward)
      const recipient = decoded.recipient.toLowerCase()
      const block = Number.parseInt(forward.blockNumber, 16)
      if (recipient === BENEFICIARY_VAULT_LOWER) {
        events.feesForwardedVault.push({
          kind: 'feesForwardedVault',
          block,
          ts: tsOf(forward),
          txHash: forward.transactionHash,
          logIndex: Number.parseInt(forward.logIndex, 16),
          currency: decoded.currency.toLowerCase() === FRONG_ADDRESS_LOWER ? 'FRONG' : 'ETH',
          amount: decoded.amount.toString(),
        })
      } else if (recipient === COMPOUNDING_RECIPIENT_LOWER) {
        events.feesForwardedCompound.push({
          kind: 'feesForwardedCompound',
          block,
          ts: tsOf(forward),
          txHash: forward.transactionHash,
          logIndex: Number.parseInt(forward.logIndex, 16),
          currency: decoded.currency.toLowerCase() === FRONG_ADDRESS_LOWER ? 'FRONG' : 'ETH',
          amount: decoded.amount.toString(),
        })
      }
    }
  }

  for (const log of input.vaultLogs) {
    if (log.topics[1]?.toLowerCase() !== POSITION_ID_WORD.toLowerCase()) continue
    if (!inRange(log)) continue
    const block = Number.parseInt(log.blockNumber, 16)
    const ts = tsOf(log)
    const logIndex = Number.parseInt(log.logIndex, 16)
    if (log.topics[0]?.toLowerCase() === TOPIC_AMOUNTS_RECEIVED) {
      const decoded = decodeAmountsReceived(log)
      events.vaultAmountsReceived.push({
        kind: 'vaultAmountsReceived',
        block,
        ts,
        txHash: log.transactionHash,
        logIndex,
        eth: decoded.currency0.toString(),
        frong: decoded.currency1.toString(),
      })
    } else if (log.topics[0]?.toLowerCase() === TOPIC_CLAIMED) {
      const decoded = decodeClaimed(log)
      events.vaultClaimed.push({
        kind: 'vaultClaimed',
        block,
        ts,
        txHash: log.transactionHash,
        logIndex,
        eth: decoded.currency0.toString(),
        frong: decoded.currency1.toString(),
      })
    }
  }

  for (const log of input.compoundLogs) {
    if (log.topics[1]?.toLowerCase() !== POSITION_ID_WORD.toLowerCase()) continue
    if (!inRange(log)) continue
    const block = Number.parseInt(log.blockNumber, 16)
    const ts = tsOf(log)
    const logIndex = Number.parseInt(log.logIndex, 16)
    if (log.topics[0]?.toLowerCase() === TOPIC_AMOUNTS_RECEIVED) {
      const decoded = decodeAmountsReceived(log)
      events.compoundAmountsReceived.push({
        kind: 'compoundAmountsReceived',
        block,
        ts,
        txHash: log.transactionHash,
        logIndex,
        eth: decoded.currency0.toString(),
        frong: decoded.currency1.toString(),
      })
    } else if (log.topics[0]?.toLowerCase() === TOPIC_CLAIMED) {
      const decoded = decodeClaimed(log)
      events.compoundClaimed.push({
        kind: 'compoundClaimed',
        block,
        ts,
        txHash: log.transactionHash,
        logIndex,
        eth: decoded.currency0.toString(),
        frong: decoded.currency1.toString(),
      })
    }
  }

  for (const log of input.modifyLiquidityLogs) {
    if (!inRange(log)) continue
    const decoded = decodeModifyLiquidity(log)
    if (decoded.salt.toLowerCase() !== POSITION_ID_WORD.toLowerCase()) continue
    events.modifyLiquidity.push({
      kind: 'modifyLiquidity',
      block: Number.parseInt(log.blockNumber, 16),
      ts: tsOf(log),
      txHash: log.transactionHash,
      logIndex: Number.parseInt(log.logIndex, 16),
      tickLower: decoded.tickLower,
      tickUpper: decoded.tickUpper,
      delta: decoded.delta,
    })
  }

  return events
}

// ---------------------------------------------------------------------------
// Idempotent merge (dedupe by txHash + logIndex, monotonic blocks)
// ---------------------------------------------------------------------------

export function eventKey(event: FrEvent): string {
  return event.txHash.toLowerCase() + '|' + event.logIndex
}

const ALL_KINDS: readonly FrEventKind[] = [
  'feesCollected',
  'feesForwardedVault',
  'feesForwardedCompound',
  'vaultAmountsReceived',
  'vaultClaimed',
  'compoundAmountsReceived',
  'compoundClaimed',
  'modifyLiquidity',
]

export function mergeEventCollections(
  previous: EventsCollections,
  incoming: EventsCollections,
): EventsCollections {
  const seen = new Set<string>()
  const merged = {} as EventsCollections
  for (const kind of ALL_KINDS) {
    const list: FrEvent[] = []
    for (const event of [...previous[kind], ...incoming[kind]]) {
      const key = eventKey(event)
      if (seen.has(key)) continue
      seen.add(key)
      list.push(event)
    }
    list.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    merged[kind] = list as never
  }
  return merged
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

const sum = (values: bigint[]): bigint => values.reduce((acc, value) => acc + value, 0n)

export function computeTotals(events: EventsCollections): ArtifactTotals {
  const feesCollectedEth = sum(events.feesCollected.map((e) => BigInt(e.eth)))
  const feesCollectedFrong = sum(events.feesCollected.map((e) => BigInt(e.frong)))
  const forwardedBeneficiaryEth = sum(
    events.feesForwardedVault.filter((e) => e.currency === 'ETH').map((e) => BigInt(e.amount)),
  )
  const forwardedBeneficiaryFrong = sum(
    events.feesForwardedVault.filter((e) => e.currency === 'FRONG').map((e) => BigInt(e.amount)),
  )
  const compoundedEth = sum(
    events.feesForwardedCompound.filter((e) => e.currency === 'ETH').map((e) => BigInt(e.amount)),
  )
  const compoundedFrong = sum(
    events.feesForwardedCompound.filter((e) => e.currency === 'FRONG').map((e) => BigInt(e.amount)),
  )
  const vaultClaimedEth = sum(events.vaultClaimed.map((e) => BigInt(e.eth)))
  const vaultClaimedFrong = sum(events.vaultClaimed.map((e) => BigInt(e.frong)))
  const liquidityAdds = events.modifyLiquidity.filter((e) => BigInt(e.delta) > 0n).length
  const liquidityRemoves = events.modifyLiquidity.filter((e) => BigInt(e.delta) < 0n).length
  const feeSettlements = events.modifyLiquidity.filter((e) => BigInt(e.delta) === 0n).length
  const positionLiquidityNet = sum(events.modifyLiquidity.map((e) => BigInt(e.delta)))
  return {
    feesCollectedEth: feesCollectedEth.toString(),
    feesCollectedFrong: feesCollectedFrong.toString(),
    forwardedBeneficiaryEth: forwardedBeneficiaryEth.toString(),
    forwardedBeneficiaryFrong: forwardedBeneficiaryFrong.toString(),
    compoundedEth: compoundedEth.toString(),
    compoundedFrong: compoundedFrong.toString(),
    vaultClaimedEth: vaultClaimedEth.toString(),
    vaultClaimedFrong: vaultClaimedFrong.toString(),
    liquidityAdds,
    liquidityRemoves,
    feeSettlements,
    claims: events.feesCollected.length,
    compounds: events.compoundClaimed.length,
    positionLiquidityNet: positionLiquidityNet.toString(),
  }
}

/** UTC calendar date (YYYY-MM-DD) for a unix timestamp. */
export function dayKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

export function computeDaily(events: EventsCollections): DailyAggregate[] {
  const days = new Map<string, DailyAggregate>()
  const ensure = (date: string): DailyAggregate => {
    let day = days.get(date)
    if (!day) {
      day = {
        date,
        claims: 0,
        feesCollectedEth: '0',
        feesCollectedFrong: '0',
        compoundedEth: '0',
        compoundedFrong: '0',
        forwardedVaultEth: '0',
        forwardedVaultFrong: '0',
        liquidityAdds: 0,
        feeSettlements: 0,
        liquidityAtEnd: '0',
      }
      days.set(date, day)
    }
    return day
  }
  for (const event of events.feesCollected) {
    const day = ensure(dayKey(event.ts))
    day.claims += 1
    day.feesCollectedEth = (BigInt(day.feesCollectedEth) + BigInt(event.eth)).toString()
    day.feesCollectedFrong = (BigInt(day.feesCollectedFrong) + BigInt(event.frong)).toString()
  }
  for (const event of events.feesForwardedVault) {
    const day = ensure(dayKey(event.ts))
    if (event.currency === 'ETH') {
      day.forwardedVaultEth = (BigInt(day.forwardedVaultEth) + BigInt(event.amount)).toString()
    } else {
      day.forwardedVaultFrong = (BigInt(day.forwardedVaultFrong) + BigInt(event.amount)).toString()
    }
  }
  for (const event of events.feesForwardedCompound) {
    const day = ensure(dayKey(event.ts))
    if (event.currency === 'ETH') {
      day.compoundedEth = (BigInt(day.compoundedEth) + BigInt(event.amount)).toString()
    } else {
      day.compoundedFrong = (BigInt(day.compoundedFrong) + BigInt(event.amount)).toString()
    }
  }
  for (const event of events.modifyLiquidity) {
    const day = ensure(dayKey(event.ts))
    const delta = BigInt(event.delta)
    if (delta > 0n) day.liquidityAdds += 1
    else if (delta === 0n) day.feeSettlements += 1
    // negative deltas (liquidity removed) are tracked in totals only
  }
  const sorted = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  let liquidity = 0n
  for (const day of sorted) {
    for (const event of events.modifyLiquidity) {
      if (dayKey(event.ts) === day.date) liquidity += BigInt(event.delta)
    }
    day.liquidityAtEnd = liquidity.toString()
  }
  return sorted
}

export function buildRecent(events: EventsCollections, limit: number): RecentEvent[] {
  const rows: RecentEvent[] = []
  const kindNames: Record<FrEventKind, string> = {
    feesCollected: 'Fees collected',
    feesForwardedVault: 'Forwarded to beneficiary',
    feesForwardedCompound: 'Compounded',
    vaultAmountsReceived: 'Attributed to beneficiary vault',
    vaultClaimed: 'Beneficiary claim',
    compoundAmountsReceived: 'Attributed for compounding',
    compoundClaimed: 'Compound claim',
    modifyLiquidity: 'Liquidity added/removed',
  }
  for (const kind of Object.keys(events) as FrEventKind[]) {
    for (const event of events[kind]) {
      let eth = '0'
      let frong = '0'
      let delta = '0'
      if (kind === 'feesCollected') {
        eth = (event as { eth: string }).eth
        frong = (event as { frong: string }).frong
      } else if (
        kind === 'vaultAmountsReceived' ||
        kind === 'vaultClaimed' ||
        kind === 'compoundAmountsReceived' ||
        kind === 'compoundClaimed'
      ) {
        eth = (event as { eth: string }).eth
        frong = (event as { frong: string }).frong
      } else if (kind === 'feesForwardedVault' || kind === 'feesForwardedCompound') {
        const forward = event as { currency: string; amount: string }
        if (forward.currency === 'ETH') eth = forward.amount
        else frong = forward.amount
      } else if (kind === 'modifyLiquidity') {
        delta = (event as { delta: string }).delta
      }
      rows.push({
        ts: event.ts,
        block: event.block,
        txHash: event.txHash,
        logIndex: event.logIndex,
        kind,
        eth,
        frong,
        delta,
        title: kindNames[kind],
      })
    }
  }
  rows.sort((a, b) => b.ts - a.ts || b.block - a.block)
  return rows.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Artifact assembly
// ---------------------------------------------------------------------------

export function buildArtifact(input: {
  events: EventsCollections
  cursorBlock: number
  cursorAt: string
  asOfBlock: number
  asOfTimestamp: number
  generatedAt: string
  scope?: Partial<FrongAnalyticsArtifact['scope']>
}): FrongAnalyticsArtifact {
  const totals = computeTotals(input.events)
  const baseScope: FrongAnalyticsArtifact['scope'] = {
    token: { symbol: 'FRONG', address: FRONG_ADDRESS, decimals: 18 },
    pool: {
      id: POOL_ID,
      currency0: 'ETH',
      currency1: 'FRONG',
      feeUnits: Number(POOL_FEE_UNITS),
      feeLabel: '0.25% (static pool-key LP fee)',
      tickSpacing: 60,
      hooks: null,
      protocolFeeUnitsPerDirection: Number(PROTOCOL_FEE_UNITS),
      protocolFeeLabel: '0.04% per direction (protocol fee - goes to the protocol, not LPs)',
      dex: 'Uniswap V4-compatible pool (PancakeSwap v4-core lineage)',
      venue: 'Pools.trade (surfaced as FRONG/ETH)',
    },
    position: {
      tokenId: Number(POSITION_TOKEN_ID),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      rangeLabel: '[-208,980 ... 198,060]',
      custodian: FEE_SPLITTER,
      custodianLabel: 'FeeSplitter (owns the position NFT)',
    },
    contracts: {
      feeSplitter: FEE_SPLITTER,
      beneficiaryVault: BENEFICIARY_VAULT,
      beneficiaryNftHolder: BENEFICIARY_NFT_HOLDER,
      compoundingRecipient: COMPOUNDING_RECIPIENT,
      positionManager: POSITION_MANAGER,
      poolManager: POOL_MANAGER,
    },
    mechanism: {
      ethBeneficiaryPct: '40%',
      ethCompoundPct: '60%',
      frongCompoundPct: '100%',
      minLiquidityIncrease: MIN_LIQUIDITY_INCREASE.toString(),
      minLiquidityIncreaseFrong: '100',
    },
    launch: {
      block: LAUNCH_BLOCK,
      at: input.scope?.launch?.at ?? '',
    },
  }
  const scope: FrongAnalyticsArtifact['scope'] = {
    token: { ...baseScope.token, ...(input.scope?.token ?? {}) },
    pool: { ...baseScope.pool, ...(input.scope?.pool ?? {}) },
    position: { ...baseScope.position, ...(input.scope?.position ?? {}) },
    contracts: { ...baseScope.contracts, ...(input.scope?.contracts ?? {}) },
    mechanism: { ...baseScope.mechanism, ...(input.scope?.mechanism ?? {}) },
    launch: { ...baseScope.launch, ...(input.scope?.launch ?? {}) },
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    chain: {
      chainId: CHAIN_ID,
      name: CHAIN_NAME,
      explorerTxUrlTemplate: EXPLORER_TX_URL_TEMPLATE,
    },
    rpc: RPC_URL,
    scope,
    cursor: { lastProcessedBlock: input.cursorBlock, lastProcessedAt: input.cursorAt },
    totals,
    daily: computeDaily(input.events),
    events: input.events,
    recent: buildRecent(input.events, 60),
    asOf: { block: input.asOfBlock, timestamp: input.asOfTimestamp },
  }
}

// ---------------------------------------------------------------------------
// Pool Swap events (v2) - exact volumes, rate word recorded but never used
// ---------------------------------------------------------------------------

export interface DecodedSwap {
  poolId: string
  sender: string
  amount0: string
  amount1: string
  tick: number
  /** Trailing event word - rate-like, NOT pinned; never used as an amount. */
  feeWord: number
}

export function decodeSwap(log: RawLog): DecodedSwap {
  const tickWord = dataWord(log.data, 4)
  let tick = Number.parseInt(tickWord.slice(-6), 16)
  if (tick > 0x7fffff) tick -= 0x1000000
  const feeWordHex = dataWord(log.data, 5)
  return {
    poolId: log.topics[1] ?? '',
    sender: topicAddress(log.topics[2] ?? ''),
    amount0: sign256(dataWord(log.data, 0)),
    amount1: sign256(dataWord(log.data, 1)),
    tick,
    feeWord: Number.parseInt(feeWordHex.slice(-6), 16),
  }
}

export function swapEventKey(swap: SwapEvent): string {
  return swap.txHash.toLowerCase() + '|' + swap.logIndex
}

/** Exact token volumes: sum of |amount0| (ETH) and |amount1| (FRONG). */
export function swapTotals(swaps: SwapEvent[]): {
  volEth: string
  volFrong: string
  swapCount: number
} {
  let volEth = 0n
  let volFrong = 0n
  for (const swap of swaps) {
    let a0 = BigInt(swap.amount0)
    let a1 = BigInt(swap.amount1)
    if (a0 < 0n) a0 = -a0
    if (a1 < 0n) a1 = -a1
    volEth += a0
    volFrong += a1
  }
  return { volEth: volEth.toString(), volFrong: volFrong.toString(), swapCount: swaps.length }
}

/**
 * Bucket swaps into UTC days using a precomputed ascending boundary table:
 * [{ date: 'YYYY-MM-DD', block: firstBlockOfDay }]. Swaps before the first
 * boundary are attributed to the first day (launch day).
 */
export function bucketSwapsDaily(
  swaps: SwapEvent[],
  boundaries: { date: string; block: number }[],
): DailyAggregate[] {
  const rows = new Map<string, DailyAggregate>()
  const ensure = (date: string): DailyAggregate => {
    let row = rows.get(date)
    if (!row) {
      row = {
        date,
        claims: 0,
        feesCollectedEth: '0',
        feesCollectedFrong: '0',
        compoundedEth: '0',
        compoundedFrong: '0',
        forwardedVaultEth: '0',
        forwardedVaultFrong: '0',
        liquidityAdds: 0,
        feeSettlements: 0,
        liquidityAtEnd: '0',
        swaps: 0,
        volEth: '0',
        volFrong: '0',
      }
      rows.set(date, row)
    }
    return row
  }
  const dayOf = (block: number): string => {
    let day = boundaries[0]?.date ?? '1970-01-01'
    for (const boundary of boundaries) {
      if (block >= boundary.block) day = boundary.date
      else break
    }
    return day
  }
  for (const swap of swaps) {
    const row = ensure(dayOf(swap.block))
    row.swaps = (row.swaps ?? 0) + 1
    let a0 = BigInt(swap.amount0)
    let a1 = BigInt(swap.amount1)
    if (a0 < 0n) a0 = -a0
    if (a1 < 0n) a1 = -a1
    row.volEth = (BigInt(row.volEth ?? '0') + a0).toString()
    row.volFrong = (BigInt(row.volFrong ?? '0') + a1).toString()
  }
  return [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** Bucket swaps into UTC hours (ISO 'YYYY-MM-DDTHH:00:00Z' keys). */
export function bucketSwapsHourly(
  swaps: SwapEvent[],
  boundaries: { hour: string; block: number }[],
): HourlyAggregate[] {
  const rows = new Map<string, HourlyAggregate>()
  const ensure = (hour: string): HourlyAggregate => {
    let row = rows.get(hour)
    if (!row) {
      row = { hour, swaps: 0, volEth: '0', volFrong: '0' }
      rows.set(hour, row)
    }
    return row
  }
  const hourOf = (block: number): string => {
    let hour = boundaries[0]?.hour ?? '1970-01-01T00:00:00Z'
    for (const boundary of boundaries) {
      if (block >= boundary.block) hour = boundary.hour
      else break
    }
    return hour
  }
  for (const swap of swaps) {
    const row = ensure(hourOf(swap.block))
    row.swaps += 1
    let a0 = BigInt(swap.amount0)
    let a1 = BigInt(swap.amount1)
    if (a0 < 0n) a0 = -a0
    if (a1 < 0n) a1 = -a1
    row.volEth = (BigInt(row.volEth) + a0).toString()
    row.volFrong = (BigInt(row.volFrong) + a1).toString()
  }
  return [...rows.values()].sort((a, b) => (a.hour < b.hour ? -1 : 1))
}

/** Dedupe-by-key merge for recent swap windows. */
export function mergeSwapRecent(
  previous: SwapEvent[],
  incoming: SwapEvent[],
  limit: number,
): SwapEvent[] {
  const seen = new Set<string>()
  const merged: SwapEvent[] = []
  for (const swap of [...previous, ...incoming]) {
    const key = swapEventKey(swap)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(swap)
  }
  merged.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)
  return merged.slice(0, limit)
}

/**
 * Pool fee derivation from EXACT volumes and the VERIFIED static fee rates.
 * traderFee = vol x (0.25% + 0.04%); lpFee = vol x 0.25% (what accrues to
 * in-range LPs, including position 409801). The Swap event's trailing rate
 * word is NOT used here. Label: Derived (verified static fee x exact volume).
 */
export function derivePoolFees(
  volEth: string,
  volFrong: string,
): {
  lpFeeEth: string
  lpFeeFrong: string
  protocolFeeEth: string
  protocolFeeFrong: string
} {
  const feePerMillion = Number(POOL_FEE_UNITS + PROTOCOL_FEE_UNITS) // 2900
  const lpPerMillion = Number(POOL_FEE_UNITS) // 2500
  const traderEth = (BigInt(volEth) * BigInt(feePerMillion)) / 1000000n
  const lpEth = (BigInt(volEth) * BigInt(lpPerMillion)) / 1000000n
  const traderFrong = (BigInt(volFrong) * BigInt(feePerMillion)) / 1000000n
  const lpFrong = (BigInt(volFrong) * BigInt(lpPerMillion)) / 1000000n
  return {
    lpFeeEth: lpEth.toString(),
    lpFeeFrong: lpFrong.toString(),
    protocolFeeEth: (traderEth - lpEth).toString(),
    protocolFeeFrong: (traderFrong - lpFrong).toString(),
  }
}

/** Position share of pool LP fees (0..1, decimal string). */
export function positionFeeShare(positionFee: bigint, poolLpFee: bigint): string | null {
  if (poolLpFee <= 0n) return null
  const bps = (positionFee * 10000n) / poolLpFee
  return (Number(bps) / 100).toFixed(2)
}
