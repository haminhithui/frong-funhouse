/**
 * Shared types for the FRONG fee/liquidity analytics artifact.
 *
 * Every number in the artifact is derived from on-chain events on Robinhood
 * Chain mainnet (chain 4663) — never invented. Amounts are decimal strings in
 * raw wei units (18 decimals for FRONG and native ETH); timestamps are unix
 * seconds (UTC). The artifact is produced by scripts/frong-analytics.mjs and
 * consumed by the read-only dashboard.
 */

/** A raw JSON-RPC log entry as returned by eth_getLogs. */
export interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  logIndex: string
  transactionHash: string
}

export type FrEventKind =
  | 'feesCollected'
  | 'feesForwardedVault'
  | 'feesForwardedCompound'
  | 'vaultAmountsReceived'
  | 'vaultClaimed'
  | 'compoundAmountsReceived'
  | 'compoundClaimed'
  | 'modifyLiquidity'

interface FrEventBase {
  kind: FrEventKind
  /** Block number the event was included in (exact). */
  block: number
  /** Block timestamp, unix seconds UTC (exact — read from the block header). */
  ts: number
  txHash: string
  /** Log index within the transaction (used for idempotent dedupe). */
  logIndex: number
}

/** FeeSplitter FeesCollected(tokenId indexed, currency indexed, uint256 amount0, uint256 amount1). */
export interface FrFeesCollected extends FrEventBase {
  kind: 'feesCollected'
  /** Total native ETH collected for the position in this claim (wei). */
  eth: string
  /** Total FRONG collected for the position in this claim (wei). */
  frong: string
}

/** FeeSplitter FeesForwarded(recipient indexed, currency indexed, uint256 amount). */
export interface FrFeesForwarded extends FrEventBase {
  kind: 'feesForwardedVault' | 'feesForwardedCompound'
  currency: 'ETH' | 'FRONG'
  /** Amount forwarded to the recipient in this currency (wei). */
  amount: string
}

/** Recipient AmountsReceived(tokenId indexed, uint256 currency0Amount, uint256 currency1Amount). */
export interface FrAmountsReceived extends FrEventBase {
  kind: 'vaultAmountsReceived' | 'compoundAmountsReceived'
  eth: string
  frong: string
}

/** Recipient Claimed(tokenId indexed, uint256 currency0Amount, uint256 currency1Amount, PoolKey). */
export interface FrClaimed extends FrEventBase {
  kind: 'vaultClaimed' | 'compoundClaimed'
  eth: string
  frong: string
}

/**
 * PoolManager ModifyLiquidity(id indexed, sender indexed, int24 tickLower,
 * int24 tickUpper, int256 liquidityDelta, bytes32 salt) for the FRONG/ETH pool,
 * filtered to the position whose salt encodes token id 409801.
 */
export interface FrModifyLiquidity extends FrEventBase {
  kind: 'modifyLiquidity'
  tickLower: number
  tickUpper: number
  /** Positive = liquidity added to the position, negative = removed (wei units). */
  delta: string
}

export type FrEvent =
  FrFeesCollected | FrFeesForwarded | FrAmountsReceived | FrClaimed | FrModifyLiquidity

/** Position-scoped events grouped by exact kind (discriminated arrays). */
export interface EventsCollections {
  feesCollected: FrFeesCollected[]
  feesForwardedVault: FrFeesForwarded[]
  feesForwardedCompound: FrFeesForwarded[]
  vaultAmountsReceived: FrAmountsReceived[]
  vaultClaimed: FrClaimed[]
  compoundAmountsReceived: FrAmountsReceived[]
  compoundClaimed: FrClaimed[]
  modifyLiquidity: FrModifyLiquidity[]
}

/** One derived calendar day of aggregates (UTC). */
export interface DailyAggregate {
  date: string
  claims: number
  feesCollectedEth: string
  feesCollectedFrong: string
  compoundedEth: string
  compoundedFrong: string
  forwardedVaultEth: string
  forwardedVaultFrong: string
  liquidityAdds: number
  /**
   * ModifyLiquidity events with a zero delta - on-chain fee settlements that
   * credit accrued fees to the position without changing its liquidity.
   */
  feeSettlements: number
  /** Cumulative position liquidity at the end of the day (wei units). */
  liquidityAtEnd: string
  // ---- v2 additive swap fields (absent in v1 artifacts) ----
  /** Exact swap-event count for the pool this day. */
  swaps?: number
  /** Exact native-ETH swap volume this day, sum of |amount0| (wei). */
  volEth?: string
  /** Exact FRONG swap volume this day, sum of |amount1| (wei). */
  volFrong?: string
}

/** One hour of swap aggregates (last 48h of the scan; ISO hour, UTC). */
export interface HourlyAggregate {
  hour: string
  swaps: number
  volEth: string
  volFrong: string
}

/** A decoded pool Swap event (exact signed legs; fee word recorded, unused). */
export interface SwapEvent {
  block: number
  ts?: number
  txHash: string
  logIndex: number
  /** int128 leg, decimal string (positive = into pool, negative = out). */
  amount0: string
  /** int128 leg, decimal string. */
  amount1: string
}

export interface SwapScanMeta {
  /** True only when the swap scan covered launchBlock..finalizedLatest without gaps. */
  completed: boolean
  fromBlock: number
  toBlock: number
  fetchedAt: string
  swapCount: number
}

export interface SwapData {
  scan: SwapScanMeta
  /** Present only when scan.completed (never partial). */
  totals?: { volEth: string; volFrong: string; swapCount: number }
  daily: DailyAggregate[]
  hourly: HourlyAggregate[]
  recent: SwapEvent[]
}

/** One row of the unified recent-events feed. */
export interface RecentEvent {
  ts: number
  block: number
  txHash: string
  /** Log index within the transaction (unique per tx; used as the row key). */
  logIndex: number
  kind: FrEventKind
  eth: string
  frong: string
  delta: string
  title: string
}

export interface ArtifactTotals {
  feesCollectedEth: string
  feesCollectedFrong: string
  forwardedBeneficiaryEth: string
  forwardedBeneficiaryFrong: string
  compoundedEth: string
  compoundedFrong: string
  vaultClaimedEth: string
  vaultClaimedFrong: string
  liquidityAdds: number
  liquidityRemoves: number
  feeSettlements: number
  claims: number
  compounds: number
  positionLiquidityNet: string
  // ---- v2 additive swap totals (absent when the scan is incomplete) ----
  volEth?: string
  volFrong?: string
  swapCount?: number
}

export interface ArtifactScope {
  token: { symbol: 'FRONG'; address: string; decimals: 18 }
  pool: {
    id: string
    currency0: 'ETH'
    currency1: 'FRONG'
    /** Static pool-key LP fee in hundredths of a bip (2500 = 0.25%). */
    feeUnits: number
    feeLabel: string
    tickSpacing: number
    hooks: string | null
    /** Protocol fee per direction, hundredths of a bip (400 = 0.04%). */
    protocolFeeUnitsPerDirection: number
    protocolFeeLabel: string
    dex: string
    venue: string
  }
  position: {
    tokenId: number
    tickLower: number
    tickUpper: number
    rangeLabel: string
    custodian: string
    custodianLabel: string
  }
  contracts: {
    feeSplitter: string
    beneficiaryVault: string
    beneficiaryNftHolder: string
    compoundingRecipient: string
    positionManager: string
    poolManager: string
  }
  mechanism: {
    /** Measured from events: ETH share forwarded to the beneficiary. */
    ethBeneficiaryPct: string
    /** Measured from events: ETH share reinvested (compounded). */
    ethCompoundPct: string
    /** Measured from events: FRONG share reinvested (compounded). */
    frongCompoundPct: string
    /** CompoundingClaimRecipient.minLiquidityIncrease() — a threshold, never a fee %. */
    minLiquidityIncrease: string
    minLiquidityIncreaseFrong: string
  }
  launch: { block: number; at: string }
}

export interface FrongAnalyticsArtifact {
  /** v1 artifacts have no swap data; v2 adds the swaps section (additive). */
  schemaVersion: 1 | 2
  generatedAt: string
  chain: { chainId: 4663; name: string; explorerTxUrlTemplate: string }
  rpc: string
  scope: ArtifactScope
  cursor: { lastProcessedBlock: number; lastProcessedAt: string }
  totals: ArtifactTotals
  daily: DailyAggregate[]
  events: EventsCollections
  recent: RecentEvent[]
  asOf: { block: number; timestamp: number }
  /** v2 only: pool swap scan aggregates (absent in v1). */
  swaps?: SwapData
}

/** Internal claim pairing produced by the FeeSplitter log walker. */
export interface ClaimPair {
  txHash: string
  block: number
  tokenId: string
  eth: bigint
  frong: bigint
  vaultEth: bigint
  vaultFrong: bigint
  compoundEth: bigint
  compoundFrong: bigint
  feesCollected: RawLog
  forwards: RawLog[]
  /**
   * True when the claim's forwards do not sum to the collected totals (other
   * positions can lag ETH forwards across claims). Position 409801 pairs
   * exactly (verified across full history: 0 mismatches).
   */
  pairingMismatch?: boolean
}
