import {
  BENEFICIARY_VAULT,
  COMPOUNDING_RECIPIENT,
  POOL_ID,
  POSITION_ID_WORD,
  TOPIC_AMOUNTS_RECEIVED,
  TOPIC_CLAIMED,
  TOPIC_FEES_COLLECTED,
  TOPIC_FEES_FORWARDED,
  TOPIC_MODIFY_LIQUIDITY,
  buildPositionEvents,
  buildRecent,
  computeDaily,
  computeTotals,
  dataWord,
  dayKey,
  decodeAmountsReceived,
  decodeFeesCollected,
  decodeFeesForwarded,
  decodeModifyLiquidity,
  eventKey,
  mergeEventCollections,
  pairFeeSplitterClaims,
  sign24,
  sign256,
} from '../analytics/core'
import type { EventsCollections, FrEvent, FrFeesCollected, RawLog } from '../analytics/types'

const FEE_SPLITTER = '0x7198c32a497c09497e04c86cf8f77a244a9e4b8f'
const FRONG = '0x6245e67affa44a23077f0ea7f981a8dc743a0c47'

function log(partial: Partial<RawLog> & Pick<RawLog, 'topics' | 'data'>): RawLog {
  return {
    address: FEE_SPLITTER,
    blockNumber: '0x1682f4f',
    logIndex: '0x0',
    transactionHash: '0x' + 'a'.repeat(64),
    ...partial,
  }
}

describe('sign helpers', () => {
  it('sign-extends 24-bit two-complement words', () => {
    expect(sign24('0x00000000000000000000000000000000000000000000000000000000000305ac')).toBe(
      198060,
    )
    // -208980 in 24-bit two's complement, sign-extended into a full word
    expect(sign24('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffccfac')).toBe(
      -208980,
    )
  })

  it('sign-extends int256 words', () => {
    expect(sign256('0x0000000000000000000000000000000000000000000000000000000000000064')).toBe(
      '100',
    )
    expect(sign256('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c')).toBe(
      '-100',
    )
  })

  it('reads data words by index', () => {
    const data = '0x' + '00'.repeat(31) + '64' + '00'.repeat(31) + 'c8' + '00'.repeat(64)
    expect(dataWord(data, 0)).toBe('0x' + '00'.repeat(31) + '64')
    expect(dataWord(data, 1)).toBe('0x' + '00'.repeat(31) + 'c8')
    expect(dataWord(data, 2)).toBe('0x' + '00'.repeat(32))
    expect(dataWord(data, 5)).toBe('')
  })
})

describe('event decoding', () => {
  it('decodes a real ModifyLiquidity log for position 409801', () => {
    const raw = log({
      address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
      topics: [
        TOPIC_MODIFY_LIQUIDITY,
        POOL_ID,
        '0x00000000000000000000000058daec3116aae6d93017baaea7749052e8a04fa7',
      ],
      data:
        '0x' +
        'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffccfac' +
        '00000000000000000000000000000000000000000000000000000000000305ac' +
        '000000000000000000000000000000000000000000000a992b972a7b50ffbba6' +
        '00000000000000000000000000000000000000000000000000000000000640c9',
    })
    const decoded = decodeModifyLiquidity(raw)
    expect(decoded.tickLower).toBe(-208980)
    expect(decoded.tickUpper).toBe(198060)
    expect(BigInt(decoded.delta)).toBeGreaterThan(0n)
    expect(decoded.salt.toLowerCase()).toBe(POSITION_ID_WORD.toLowerCase())
  })

  it('decodes FeesCollected and FeesForwarded fields', () => {
    const collected = decodeFeesCollected(
      log({
        topics: [
          TOPIC_FEES_COLLECTED,
          POSITION_ID_WORD,
          '0x000000000000000000000000' + FRONG.slice(2),
        ],
        data:
          '0x' +
          0x9711288e96aaecfcn.toString(16).padStart(64, '0') +
          0x0eb731b18d976df3bda57bn.toString(16).padStart(64, '0'),
      }),
    )
    expect(collected.tokenId.toLowerCase()).toBe(POSITION_ID_WORD.toLowerCase())
    expect(collected.amount0).toBe(0x9711288e96aaecfcn)
    expect(collected.amount1).toBe(0x0eb731b18d976df3bda57bn)

    const forwarded = decodeFeesForwarded(
      log({
        topics: [
          TOPIC_FEES_FORWARDED,
          '0x000000000000000000000000' + COMPOUNDING_RECIPIENT.slice(2),
          '0x000000000000000000000000' + FRONG.slice(2),
        ],
        data: '0x' + 0x0eb731b18d976df3bda57bn.toString(16).padStart(64, '0'),
      }),
    )
    expect(forwarded.recipient.toLowerCase()).toBe(COMPOUNDING_RECIPIENT)
    expect(forwarded.amount).toBe(0x0eb731b18d976df3bda57bn)
  })

  it('decodes AmountsReceived (packed uint128 pair)', () => {
    const decoded = decodeAmountsReceived(
      log({
        address: '0x587d2fdddf14f6f84022b51e8c3a473eb88c4544',
        topics: [TOPIC_AMOUNTS_RECEIVED, POSITION_ID_WORD],
        data: '0x' + 0x3c6d436c3c445ecbn.toString(16).padStart(64, '0') + '00'.repeat(32),
      }),
    )
    expect(decoded.currency0).toBe(0x3c6d436c3c445ecbn)
    expect(decoded.currency1).toBe(0n)
  })
})

describe('FeeSplitter claim pairing', () => {
  const tx = '0x' + 'c'.repeat(64)
  const collectedEth = 0x9711288e96aaecfcn
  const collectedFrong = 0x0eb731b18d976df3bda57bn
  const vaultEth = 0x3c6d436c3c445ecbn
  const compoundEth = 0x5aa3e5225a668e30n
  const pad = (value: bigint) => value.toString(16).padStart(64, '0')
  const padAddr = (address: string) => '0x000000000000000000000000' + address.slice(2)

  const fixtureLogs: RawLog[] = [
    log({
      transactionHash: tx,
      logIndex: '0x0',
      topics: [TOPIC_FEES_COLLECTED, POSITION_ID_WORD, padAddr(FRONG)],
      data: '0x' + pad(collectedEth) + pad(collectedFrong),
    }),
    log({
      transactionHash: tx,
      logIndex: '0x1',
      topics: [
        TOPIC_FEES_FORWARDED,
        padAddr(BENEFICIARY_VAULT),
        padAddr('0x0000000000000000000000000000000000000000'),
      ],
      data: '0x' + pad(vaultEth),
    }),
    log({
      transactionHash: tx,
      logIndex: '0x2',
      topics: [
        TOPIC_FEES_FORWARDED,
        padAddr(COMPOUNDING_RECIPIENT),
        padAddr('0x0000000000000000000000000000000000000000'),
      ],
      data: '0x' + pad(compoundEth),
    }),
    log({
      transactionHash: tx,
      logIndex: '0x3',
      topics: [TOPIC_FEES_FORWARDED, padAddr(COMPOUNDING_RECIPIENT), padAddr(FRONG)],
      data: '0x' + pad(collectedFrong),
    }),
  ]

  it('pairs a claim with the exact 40/60 ETH and 100% FRONG split', () => {
    const claims = pairFeeSplitterClaims(fixtureLogs)
    expect(claims).toHaveLength(1)
    const claim = claims[0]
    expect(claim.pairingMismatch).toBeFalsy()
    expect(claim.vaultEth).toBe(vaultEth)
    expect(claim.compoundEth).toBe(compoundEth)
    expect(claim.vaultEth + claim.compoundEth).toBe(collectedEth - 1n) // 1 wei rounding dust
    expect(claim.vaultFrong).toBe(0n)
    expect(claim.compoundFrong).toBe(collectedFrong)
    // 40/60 split: vault share is exactly 40% of collected (rounded)
    expect((claim.vaultEth * 10000n) / collectedEth).toBe(3999n)
  })

  it('flags claims whose forwards do not balance the collected totals', () => {
    const broken = [
      log({
        transactionHash: tx,
        logIndex: '0x0',
        topics: [TOPIC_FEES_COLLECTED, POSITION_ID_WORD, padAddr(FRONG)],
        data: '0x' + pad(100n) + pad(50n),
      }),
      log({
        transactionHash: tx,
        logIndex: '0x1',
        topics: [TOPIC_FEES_FORWARDED, padAddr(COMPOUNDING_RECIPIENT), padAddr(FRONG)],
        data: '0x' + pad(50n),
      }),
    ]
    const claims = pairFeeSplitterClaims(broken)
    expect(claims).toHaveLength(1)
    expect(claims[0].pairingMismatch).toBe(true)
  })
})

describe('idempotent merge (cursor/dedupe)', () => {
  const base: FrEvent = {
    kind: 'feesCollected',
    block: 100,
    ts: 1000,
    txHash: '0x' + 'b'.repeat(64),
    logIndex: 3,
    eth: '10',
    frong: '20',
  }

  it('dedupes by txHash + logIndex', () => {
    const previous: EventsCollections = {
      feesCollected: [base],
      feesForwardedVault: [],
      feesForwardedCompound: [],
      vaultAmountsReceived: [],
      vaultClaimed: [],
      compoundAmountsReceived: [],
      compoundClaimed: [],
      modifyLiquidity: [],
    }
    const duplicate: FrFeesCollected = { ...base, eth: '999' }
    const merged = mergeEventCollections(previous, { ...previous, feesCollected: [duplicate] })
    expect(merged.feesCollected).toHaveLength(1)
    expect(merged.feesCollected[0].eth).toBe('10')
  })

  it('keys events by lowercase txHash and logIndex', () => {
    expect(eventKey(base)).toBe(base.txHash + '|3')
    const upper: FrEvent = { ...base, txHash: base.txHash.toUpperCase() }
    expect(eventKey(upper)).toBe(eventKey(base))
  })

  it('sorts merged events by block then logIndex', () => {
    const a: FrFeesCollected = { ...base, block: 5, logIndex: 2, txHash: '0x' + '1'.repeat(64) }
    const b: FrFeesCollected = { ...base, block: 5, logIndex: 1, txHash: '0x' + '2'.repeat(64) }
    const c: FrFeesCollected = { ...base, block: 4, logIndex: 9, txHash: '0x' + '3'.repeat(64) }
    const empty: EventsCollections = {
      feesCollected: [],
      feesForwardedVault: [],
      feesForwardedCompound: [],
      vaultAmountsReceived: [],
      vaultClaimed: [],
      compoundAmountsReceived: [],
      compoundClaimed: [],
      modifyLiquidity: [],
    }
    const merged = mergeEventCollections(empty, { ...empty, feesCollected: [a, b, c] })
    expect(merged.feesCollected.map((event) => event.logIndex)).toEqual([9, 1, 2])
  })
})

describe('aggregates and daily bucketing', () => {
  const empty: EventsCollections = {
    feesCollected: [],
    feesForwardedVault: [],
    feesForwardedCompound: [],
    vaultAmountsReceived: [],
    vaultClaimed: [],
    compoundAmountsReceived: [],
    compoundClaimed: [],
    modifyLiquidity: [],
  }

  it('buckets by UTC calendar day', () => {
    // 2026-08-01T23:59:30Z vs 2026-08-02T00:00:30Z
    const late = dayKey(new Date('2026-08-01T23:59:30Z').getTime() / 1000)
    const early = dayKey(new Date('2026-08-02T00:00:30Z').getTime() / 1000)
    expect(late).toBe('2026-08-01')
    expect(early).toBe('2026-08-02')
  })

  it('computes totals with the measured split preserved', () => {
    const events: EventsCollections = {
      ...empty,
      feesCollected: [
        {
          kind: 'feesCollected',
          block: 1,
          ts: 100,
          txHash: '0x' + 'd'.repeat(64),
          logIndex: 0,
          eth: 0x9711288e96aaecfcn.toString(),
          frong: 0x0eb731b18d976df3bda57bn.toString(),
        },
      ],
      feesForwardedVault: [
        {
          kind: 'feesForwardedVault',
          block: 1,
          ts: 100,
          txHash: '0x' + 'd'.repeat(64),
          logIndex: 1,
          currency: 'ETH',
          amount: 0x3c6d436c3c445ecbn.toString(),
        },
      ],
      feesForwardedCompound: [
        {
          kind: 'feesForwardedCompound',
          block: 1,
          ts: 100,
          txHash: '0x' + 'd'.repeat(64),
          logIndex: 2,
          currency: 'ETH',
          amount: 0x5aa3e5225a668e30n.toString(),
        },
        {
          kind: 'feesForwardedCompound',
          block: 1,
          ts: 100,
          txHash: '0x' + 'd'.repeat(64),
          logIndex: 3,
          currency: 'FRONG',
          amount: 0x0eb731b18d976df3bda57bn.toString(),
        },
      ],
      modifyLiquidity: [
        {
          kind: 'modifyLiquidity',
          block: 1,
          ts: 100,
          txHash: '0x' + 'e'.repeat(64),
          logIndex: 0,
          tickLower: -208980,
          tickUpper: 198060,
          delta: '500',
        },
        {
          kind: 'modifyLiquidity',
          block: 2,
          ts: 200,
          txHash: '0x' + 'f'.repeat(64),
          logIndex: 0,
          tickLower: -208980,
          tickUpper: 198060,
          delta: '-200',
        },
      ],
    }
    const totals = computeTotals(events)
    expect(totals.claims).toBe(1)
    expect(totals.liquidityAdds).toBe(1)
    expect(totals.liquidityRemoves).toBe(1)
    expect(totals.positionLiquidityNet).toBe('300')
    // 1 wei dust: forwarded ETH = collected - 1
    expect(BigInt(totals.forwardedBeneficiaryEth) + BigInt(totals.compoundedEth)).toBe(
      BigInt(totals.feesCollectedEth) - 1n,
    )
    expect(totals.forwardedBeneficiaryFrong).toBe('0')
    expect(totals.compoundedFrong).toBe(totals.feesCollectedFrong)
  })

  it('computes daily rows with cumulative liquidity', () => {
    const events: EventsCollections = {
      ...empty,
      feesCollected: [
        {
          kind: 'feesCollected',
          block: 1,
          ts: new Date('2026-08-01T12:00:00Z').getTime() / 1000,
          txHash: '0x' + '1'.repeat(64),
          logIndex: 0,
          eth: '1000000000000000000',
          frong: '2000000000000000000000',
        },
      ],
      modifyLiquidity: [
        {
          kind: 'modifyLiquidity',
          block: 1,
          ts: new Date('2026-08-01T12:00:00Z').getTime() / 1000,
          txHash: '0x' + '2'.repeat(64),
          logIndex: 0,
          tickLower: -208980,
          tickUpper: 198060,
          delta: '1000',
        },
        {
          kind: 'modifyLiquidity',
          block: 2,
          ts: new Date('2026-08-02T12:00:00Z').getTime() / 1000,
          txHash: '0x' + '3'.repeat(64),
          logIndex: 0,
          tickLower: -208980,
          tickUpper: 198060,
          delta: '-250',
        },
        {
          kind: 'modifyLiquidity',
          block: 2,
          ts: new Date('2026-08-02T18:00:00Z').getTime() / 1000,
          txHash: '0x' + '8'.repeat(64),
          logIndex: 0,
          tickLower: -208980,
          tickUpper: 198060,
          delta: '0',
        },
        {
          kind: 'modifyLiquidity',
          block: 3,
          ts: new Date('2026-08-03T12:00:00Z').getTime() / 1000,
          txHash: '0x' + '4'.repeat(64),
          logIndex: 0,
          tickLower: -208980,
          tickUpper: 198060,
          delta: '50',
        },
      ],
    }
    const daily = computeDaily(events)
    expect(daily.map((day) => day.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
    expect(daily[0].claims).toBe(1)
    expect(daily[0].feesCollectedFrong).toBe('2000000000000000000000')
    expect(daily[0].liquidityAtEnd).toBe('1000')
    expect(daily[0].feeSettlements).toBe(0)
    expect(daily[1].liquidityAtEnd).toBe('750')
    expect(daily[1].feeSettlements).toBe(1)
    expect(daily[2].liquidityAtEnd).toBe('800')
    const totals = computeTotals(events)
    expect(totals.liquidityAdds).toBe(2)
    expect(totals.liquidityRemoves).toBe(1)
    expect(totals.feeSettlements).toBe(1)
  })

  it('builds a recent feed sorted newest-first and capped', () => {
    const events: EventsCollections = {
      ...empty,
      feesCollected: [
        {
          kind: 'feesCollected',
          block: 1,
          ts: 100,
          txHash: '0x' + '5'.repeat(64),
          logIndex: 0,
          eth: '1',
          frong: '2',
        },
        {
          kind: 'feesCollected',
          block: 2,
          ts: 300,
          txHash: '0x' + '6'.repeat(64),
          logIndex: 0,
          eth: '3',
          frong: '4',
        },
        {
          kind: 'feesCollected',
          block: 3,
          ts: 200,
          txHash: '0x' + '7'.repeat(64),
          logIndex: 0,
          eth: '5',
          frong: '6',
        },
      ],
    }
    const recent = buildRecent(events, 2)
    expect(recent).toHaveLength(2)
    expect(recent[0].ts).toBe(300)
    expect(recent[1].ts).toBe(200)
    expect(recent[0].frong).toBe('4')
  })
})

describe('event stream integration (fixture)', () => {
  it('builds a position-scoped event stream from a claim + recipients + liquidity', () => {
    const tx = '0x' + '9'.repeat(64)
    const collectedEth = 0x9711288e96aaecfcn
    const collectedFrong = 0x0eb731b18d976df3bda57bn
    const vaultEth = 0x3c6d436c3c445ecbn
    const compoundEth = 0x5aa3e5225a668e30n
    const pad = (value: bigint) => value.toString(16).padStart(64, '0')
    const padAddr = (address: string) => '0x000000000000000000000000' + address.slice(2)
    const ts = 1785686400
    const claims = pairFeeSplitterClaims([
      log({
        transactionHash: tx,
        logIndex: '0x0',
        topics: [TOPIC_FEES_COLLECTED, POSITION_ID_WORD, padAddr(FRONG)],
        data: '0x' + pad(collectedEth) + pad(collectedFrong),
      }),
      log({
        transactionHash: tx,
        logIndex: '0x1',
        topics: [
          TOPIC_FEES_FORWARDED,
          padAddr(BENEFICIARY_VAULT),
          padAddr('0x0000000000000000000000000000000000000000'),
        ],
        data: '0x' + pad(vaultEth),
      }),
      log({
        transactionHash: tx,
        logIndex: '0x2',
        topics: [
          TOPIC_FEES_FORWARDED,
          padAddr(COMPOUNDING_RECIPIENT),
          padAddr('0x0000000000000000000000000000000000000000'),
        ],
        data: '0x' + pad(compoundEth),
      }),
      log({
        transactionHash: tx,
        logIndex: '0x3',
        topics: [TOPIC_FEES_FORWARDED, padAddr(COMPOUNDING_RECIPIENT), padAddr(FRONG)],
        data: '0x' + pad(collectedFrong),
      }),
    ])
    const events = buildPositionEvents({
      claims,
      vaultLogs: [
        log({
          address: BENEFICIARY_VAULT,
          transactionHash: tx,
          logIndex: '0x4',
          topics: [TOPIC_AMOUNTS_RECEIVED, POSITION_ID_WORD],
          data: '0x' + pad(vaultEth) + '00'.repeat(32),
        }),
        log({
          address: BENEFICIARY_VAULT,
          transactionHash: tx,
          logIndex: '0x5',
          topics: [TOPIC_CLAIMED, POSITION_ID_WORD],
          data: '0x' + pad(vaultEth) + '00'.repeat(32),
        }),
      ],
      compoundLogs: [],
      modifyLiquidityLogs: [
        log({
          address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
          transactionHash: tx,
          logIndex: '0x6',
          topics: [
            TOPIC_MODIFY_LIQUIDITY,
            POOL_ID,
            padAddr('0x58daec3116aae6d93017baaea7749052e8a04fa7'),
          ],
          data:
            '0x' +
            'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffccfac' +
            '00000000000000000000000000000000000000000000000000000000000305ac' +
            pad(500n) +
            POSITION_ID_WORD.slice(2),
        }),
      ],
      blockTimestamps: { get: () => ts },
      fromBlock: 0,
      toBlock: 99_999_999,
    })
    expect(events.feesCollected).toHaveLength(1)
    expect(events.feesForwardedVault).toHaveLength(1)
    expect(events.feesForwardedCompound).toHaveLength(2)
    expect(events.vaultAmountsReceived).toHaveLength(1)
    expect(events.vaultClaimed).toHaveLength(1)
    expect(events.modifyLiquidity).toHaveLength(1)
    expect(events.modifyLiquidity[0].delta).toBe('500')
  })
})
