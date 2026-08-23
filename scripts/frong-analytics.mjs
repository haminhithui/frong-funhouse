/**
 * FRONG fee/liquidity analytics pipeline (read-only, Robinhood mainnet 4663).
 *
 * Modes:
 *   node scripts/frong-analytics.mjs backfill  # full rescan from the launch block
 *   node scripts/frong-analytics.mjs update    # incremental: cursor+1 .. finalized latest
 *
 * Persists position-scoped events, pool swap aggregates (v2), derived daily
 * aggregates and provenance to public/data/frong-analytics.json.
 *
 * Swap scan rules:
 * - adaptive chunked eth_getLogs (halving on result-limit errors), polite
 *   single-flight request queue with 429 backoff,
 * - a finalized tip (latest - FINALITY_MARGIN) so consecutive runs never
 *   leave gaps,
 * - scan.completed is true only when the scan covered launch..finalizedLatest
 *   without gaps; partial totals are never written to the artifact,
 * - idempotent txHash|logIndex upserts for position events and recent swaps.
 *
 * The Swap event's trailing fee word is RATE-like and NOT pinned to verified
 * fork semantics - it is never used to derive fee amounts anywhere here.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BENEFICIARY_VAULT,
  COMPOUNDING_RECIPIENT,
  FEE_SPLITTER,
  LAUNCH_BLOCK,
  POOL_ID,
  POOL_MANAGER,
  POSITION_ID_WORD,
  RPC_URL,
  TOPIC_AMOUNTS_RECEIVED,
  TOPIC_CLAIMED,
  TOPIC_FEES_COLLECTED,
  TOPIC_FEES_FORWARDED,
  TOPIC_MODIFY_LIQUIDITY,
  TOPIC_SWAP,
  buildArtifact,
  buildPositionEvents,
  bucketSwapsDaily,
  bucketSwapsHourly,
  decodeSwap,
  mergeEventCollections,
  mergeSwapRecent,
  pairFeeSplitterClaims,
  swapTotals,
} from '../src/analytics/core.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT_PATH = join(ROOT, 'public', 'data', 'frong-analytics.json')
const FINALITY_MARGIN = 32
const RECENT_SWAPS = 60
const HOURLY_HOURS = 48

const rpc = async (method, params) => {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(method + ': ' + json.error.message)
  return json.result
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One in-flight request at a time, polite to the public endpoint. */
let inFlight = Promise.resolve()
const queueRpc = (method, params) => {
  const next = inFlight.then(async () => {
    await sleep(120)
    return rpc(method, params)
  })
  inFlight = next.catch(() => {})
  return next
}

const rpcWithRetry = async (method, params, attempts = 6) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await queueRpc(method, params)
    } catch (error) {
      if (attempt >= attempts) throw error
      await sleep(
        /too many requests|429/i.test(String(error.message)) ? 2500 * attempt : 400 * attempt,
      )
    }
  }
}

/** Chunked eth_getLogs with adaptive halving on result-limit errors. */
async function getLogsChunked({ address, topics, fromBlock, toBlock, log }) {
  const out = []
  let lo = BigInt(fromBlock)
  const hiCap = BigInt(toBlock)
  let chunk = 400000n
  while (lo <= hiCap) {
    const hi = lo + chunk - 1n < hiCap ? lo + chunk - 1n : hiCap
    try {
      const logs = await rpcWithRetry('eth_getLogs', [
        { address, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16), topics },
      ])
      out.push(...logs)
      lo = hi + 1n
      if (chunk < 400000n) chunk = chunk * 2n
      log('[' + out.length + ' logs]')
    } catch (error) {
      if (/limit of 10000|query returned more than|too many results/i.test(String(error.message))) {
        chunk = chunk / 2n
        if (chunk < 2000n) throw error
        continue
      }
      throw error
    }
  }
  return out
}

async function blockTimestamp(block) {
  const header = await rpcWithRetry('eth_getBlockByNumber', ['0x' + block.toString(16), false])
  return Number.parseInt(header.timestamp, 16)
}

/** First block whose timestamp >= target (binary search). */
async function firstBlockAt(target) {
  const latest = Number.parseInt(await rpcWithRetry('eth_blockNumber', []), 16)
  let lo = 0
  let hi = latest
  let best = latest
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const ts = await blockTimestamp(mid)
    if (ts >= target) {
      best = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return best
}

/** UTC day-boundary table: first block of each day from launch day to today. */
async function buildDayBoundaries(launchTimestamp) {
  const boundaries = []
  const now = Date.now() / 1000
  let cursor = new Date(launchTimestamp * 1000)
  cursor.setUTCHours(0, 0, 0, 0)
  while (cursor.getTime() / 1000 <= now) {
    const target = Math.floor(cursor.getTime() / 1000)
    const block = await firstBlockAt(target)
    boundaries.push({ date: cursor.toISOString().slice(0, 10), block })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return boundaries
}

/** UTC hour-boundary table for the last N hours ending at the finalized tip. */
async function buildHourBoundaries(tipTimestamp, hours) {
  const boundaries = []
  const tipHour = new Date(tipTimestamp * 1000)
  tipHour.setUTCMinutes(0, 0, 0)
  for (let i = hours; i >= 0; i--) {
    const hourStart = new Date(tipHour.getTime() - i * 3600 * 1000)
    const block = await firstBlockAt(Math.floor(hourStart.getTime() / 1000))
    boundaries.push({ hour: hourStart.toISOString().slice(0, 13) + ':00:00Z', block })
  }
  return boundaries
}

/** Fetch timestamps for distinct blocks (batched, single-flight). */
async function fetchTimestamps(blocks) {
  const distinct = [...new Set(blocks)].sort((a, b) => a - b)
  const cache = new Map()
  for (const block of distinct) {
    cache.set(block, await blockTimestamp(block))
  }
  return cache
}

function mergeDailyMaps(base, incoming) {
  const rows = new Map()
  const put = (date, row) => {
    const target = rows.get(date)
    if (!target) {
      rows.set(date, { ...row })
      return
    }
    for (const key of ['swaps', 'volEth', 'volFrong']) {
      if (row[key] === undefined) continue
      if (target[key] === undefined) target[key] = row[key]
      else if (key === 'swaps') target.swaps += row.swaps
      else target[key] = (BigInt(target[key]) + BigInt(row[key])).toString()
    }
  }
  for (const row of base) put(row.date, row)
  for (const row of incoming) put(row.date, row)
  return [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

function mergeHourlyMaps(base, incoming) {
  const rows = new Map()
  for (const row of base) rows.set(row.hour, { ...row })
  for (const row of incoming) {
    const target = rows.get(row.hour)
    if (!target) {
      rows.set(row.hour, { ...row })
      continue
    }
    target.swaps += row.swaps
    target.volEth = (BigInt(target.volEth) + BigInt(row.volEth)).toString()
    target.volFrong = (BigInt(target.volFrong) + BigInt(row.volFrong)).toString()
  }
  return [...rows.values()].sort((a, b) => (a.hour < b.hour ? -1 : 1))
}

async function main() {
  const mode = process.argv[2] === 'update' ? 'update' : 'backfill'
  let previous = null
  try {
    previous = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'))
  } catch {
    previous = null
  }

  const latestHex = await rpcWithRetry('eth_blockNumber', [])
  const latestBlock = Number.parseInt(latestHex, 16)
  const finalizedLatest = latestBlock - FINALITY_MARGIN
  const fromBlock =
    mode === 'update' && previous ? previous.cursor.lastProcessedBlock + 1 : LAUNCH_BLOCK
  const fromBlockBounded = Math.min(fromBlock, finalizedLatest)
  const rangeLabel =
    fromBlockBounded === LAUNCH_BLOCK
      ? 'launch block ' + LAUNCH_BLOCK + ' .. finalized ' + finalizedLatest
      : 'cursor+1 .. finalized (' + fromBlockBounded + ' .. ' + finalizedLatest + ')'
  console.log('[frong-analytics]', mode, '|', rangeLabel)

  const progress = (label) => (note) =>
    process.stdout.write('  ' + label + ' ' + note + String.fromCharCode(10))
  const fsProgress = progress('feesplitter')
  const vaultProgress = progress('vault')
  const compProgress = progress('compound')
  const modProgress = progress('modify-liquidity')
  const swapProgress = progress('swaps')

  const fsLogs = await getLogsChunked({
    address: FEE_SPLITTER,
    topics: [[TOPIC_FEES_COLLECTED, TOPIC_FEES_FORWARDED]],
    fromBlock: fromBlockBounded,
    toBlock: finalizedLatest,
    log: fsProgress,
  })
  const vaultLogs = await getLogsChunked({
    address: BENEFICIARY_VAULT,
    topics: [[TOPIC_AMOUNTS_RECEIVED, TOPIC_CLAIMED], POSITION_ID_WORD],
    fromBlock: fromBlockBounded,
    toBlock: finalizedLatest,
    log: vaultProgress,
  })
  const compoundLogs = await getLogsChunked({
    address: COMPOUNDING_RECIPIENT,
    topics: [[TOPIC_AMOUNTS_RECEIVED, TOPIC_CLAIMED], POSITION_ID_WORD],
    fromBlock: fromBlockBounded,
    toBlock: finalizedLatest,
    log: compProgress,
  })
  const modifyLiquidityLogs = await getLogsChunked({
    address: POOL_MANAGER,
    topics: [TOPIC_MODIFY_LIQUIDITY, POOL_ID],
    fromBlock: fromBlockBounded,
    toBlock: finalizedLatest,
    log: modProgress,
  })

  // ---- swap scan -----------------------------------------------------------
  const swapFrom =
    mode === 'update' && previous?.swaps?.scan ? previous.swaps.scan.toBlock + 1 : LAUNCH_BLOCK
  const swapFromBounded = Math.min(swapFrom, finalizedLatest)
  const swapLogs = await getLogsChunked({
    address: POOL_MANAGER,
    topics: [TOPIC_SWAP, POOL_ID],
    fromBlock: swapFromBounded,
    toBlock: finalizedLatest,
    log: swapProgress,
  })
  const swapSlice = swapLogs
    .map((log) => {
      const decoded = decodeSwap(log)
      return {
        block: Number.parseInt(log.blockNumber, 16),
        txHash: log.transactionHash,
        logIndex: Number.parseInt(log.logIndex, 16),
        amount0: decoded.amount0,
        amount1: decoded.amount1,
      }
    })
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  const prevCompleted = previous?.swaps?.scan?.completed === true
  // completed = the scan is gap-free from launch to the finalized tip:
  // - backfill: we just scanned launch..finalizedLatest in one pass
  // - update: previous scan was completed AND we scanned (prev toBlock+1)..finalizedLatest
  const completed =
    mode === 'update'
      ? prevCompleted && swapFromBounded <= finalizedLatest
      : swapFromBounded <= finalizedLatest
  console.log(
    '  swap slice:',
    swapSlice.length,
    'events | scan.completed =',
    completed,
    '| range',
    swapFromBounded,
    '..',
    finalizedLatest,
  )

  // ---- position events -----------------------------------------------------
  const claims = pairFeeSplitterClaims(fsLogs)
  const positionClaims = claims.filter(
    (claim) => claim.tokenId.toLowerCase() === POSITION_ID_WORD.toLowerCase(),
  )
  console.log(
    '  paired claims (all positions):',
    claims.length,
    '| position 409801:',
    positionClaims.length,
  )

  const positionModifyLogs = modifyLiquidityLogs.filter((log) => {
    const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data
    const salt = data.length >= 256 ? '0x' + data.slice(192, 256) : ''
    return salt.toLowerCase() === POSITION_ID_WORD.toLowerCase()
  })

  const blockNumbers = new Set()
  for (const claim of positionClaims) {
    blockNumbers.add(claim.block)
    for (const forward of claim.forwards) blockNumbers.add(Number.parseInt(forward.blockNumber, 16))
  }
  for (const log of [...vaultLogs, ...compoundLogs, ...positionModifyLogs]) {
    blockNumbers.add(Number.parseInt(log.blockNumber, 16))
  }
  blockNumbers.add(finalizedLatest)
  if (fromBlockBounded === LAUNCH_BLOCK) blockNumbers.add(LAUNCH_BLOCK)
  const timestamps = await fetchTimestamps([...blockNumbers])
  console.log('  block timestamps fetched:', timestamps.size)

  const incoming = buildPositionEvents({
    claims,
    vaultLogs,
    compoundLogs,
    modifyLiquidityLogs: positionModifyLogs,
    blockTimestamps: { get: (block) => timestamps.get(block) },
    fromBlock: fromBlockBounded - 1,
    toBlock: finalizedLatest,
  })
  const previousEvents = previous?.events ?? null
  const merged = previousEvents ? mergeEventCollections(previousEvents, incoming) : incoming
  console.log(
    '  position events (total):',
    Object.values(merged).reduce((acc, list) => acc + list.length, 0),
  )

  // ---- swap aggregation ----------------------------------------------------
  let swapData = null
  if (completed) {
    const sliceTotals = swapTotals(swapSlice)
    const prevTotals = previous?.swaps?.totals ?? null
    const totals = {
      volEth: (BigInt(prevTotals?.volEth ?? '0') + BigInt(sliceTotals.volEth)).toString(),
      volFrong: (BigInt(prevTotals?.volFrong ?? '0') + BigInt(sliceTotals.volFrong)).toString(),
      swapCount: (prevTotals?.swapCount ?? 0) + sliceTotals.swapCount,
    }
    const tipTimestamp = timestamps.get(finalizedLatest)
    const launchTimestamp = timestamps.get(LAUNCH_BLOCK) ?? 0
    const dayBoundaries = await buildDayBoundaries(launchTimestamp)
    const hourBoundaries = await buildHourBoundaries(tipTimestamp, HOURLY_HOURS)
    const sliceDaily = bucketSwapsDaily(swapSlice, dayBoundaries)
    const sliceHourly = bucketSwapsHourly(swapSlice, hourBoundaries)
    const prevDaily = previous?.swaps?.daily ?? []
    const prevHourly = previous?.swaps?.hourly ?? []
    const daily = mergeDailyMaps(prevDaily, sliceDaily)
    const hourly = mergeHourlyMaps(prevHourly, sliceHourly).slice(-HOURLY_HOURS)
    // recent swaps: merge + cap, then stamp timestamps for the newest few
    const prevRecent = previous?.swaps?.recent ?? []
    const recentRaw = mergeSwapRecent(prevRecent, swapSlice, RECENT_SWAPS * 2)
    const recentBlocks = recentRaw.slice(0, RECENT_SWAPS).map((s) => s.block)
    const recentTs = await fetchTimestamps(recentBlocks)
    const recent = recentRaw
      .slice(0, RECENT_SWAPS)
      .map((swap) => ({ ...swap, ts: recentTs.get(swap.block) ?? 0 }))
    swapData = {
      scan: {
        completed: true,
        fromBlock:
          mode === 'update' && previous?.swaps?.scan ? previous.swaps.scan.fromBlock : LAUNCH_BLOCK,
        toBlock: finalizedLatest,
        fetchedAt: new Date().toISOString(),
        swapCount: totals.swapCount,
      },
      totals,
      daily,
      hourly,
      recent,
    }
    console.log('  swap totals:', JSON.stringify(totals))
  } else {
    swapData = {
      scan: {
        completed: false,
        fromBlock: LAUNCH_BLOCK,
        toBlock: finalizedLatest,
        fetchedAt: new Date().toISOString(),
        swapCount: 0,
      },
      daily: [],
      hourly: [],
      recent: [],
    }
    console.log('  swap scan INCOMPLETE - volume/fee totals intentionally omitted')
  }

  // ---- artifact assembly ---------------------------------------------------
  const launchTimestamp = timestamps.get(LAUNCH_BLOCK) ?? 0
  const launchIso = launchTimestamp ? new Date(launchTimestamp * 1000).toISOString() : ''
  const artifact = buildArtifact({
    events: merged,
    cursorBlock: finalizedLatest,
    cursorAt: new Date().toISOString(),
    asOfBlock: finalizedLatest,
    asOfTimestamp: timestamps.get(finalizedLatest) ?? 0,
    generatedAt: new Date().toISOString(),
    scope: {
      launch: {
        block: LAUNCH_BLOCK,
        at: previous?.scope?.launch?.at ?? launchIso,
      },
    },
  })
  artifact.swaps = swapData
  if (completed && swapData.totals) {
    artifact.totals.volEth = swapData.totals.volEth
    artifact.totals.volFrong = swapData.totals.volFrong
    artifact.totals.swapCount = swapData.totals.swapCount
    const swapDailyByDate = new Map(swapData.daily.map((row) => [row.date, row]))
    const mergedDaily = new Map(artifact.daily.map((row) => [row.date, row]))
    for (const [date, row] of swapDailyByDate) {
      const target = mergedDaily.get(date)
      if (target) {
        target.swaps = row.swaps
        target.volEth = row.volEth
        target.volFrong = row.volFrong
      } else {
        mergedDaily.set(date, {
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
          swaps: row.swaps,
          volEth: row.volEth,
          volFrong: row.volFrong,
        })
      }
    }
    artifact.daily = [...mergedDaily.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  }

  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true })
  writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + String.fromCharCode(10))
  const bytes = Buffer.byteLength(JSON.stringify(artifact))
  console.log('  written', ARTIFACT_PATH, '(' + (bytes / 1024).toFixed(1) + ' KiB)')
  console.log('  totals:', JSON.stringify(artifact.totals))
  console.log(
    '  asOf block',
    artifact.asOf.block,
    '| ts',
    new Date(artifact.asOf.timestamp * 1000).toISOString(),
  )
}

main().catch((error) => {
  console.error('[frong-analytics] failed:', error)
  process.exitCode = 1
})
