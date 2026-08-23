/**
 * Standalone FRONG fee/liquidity analytics screen (hash route #/analytics).
 *
 * All exact figures come from the persisted artifact (on-chain events +
 * completed swap scan). The DexScreener strip is strictly ESTIMATED, sourced
 * and timestamped, and never feeds the exact totals. When the swap scan is
 * incomplete, volume and fee-derived fields render as Unavailable - partial
 * totals are never shown.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChartDataTable, GroupedBarChart, LineChart, StackedBarChart } from './charts'
import { derivePoolFees, positionFeeShare, SWAP_FEE_WORD_OBSERVED } from './core'
import {
  formatDateTime,
  formatLiquidity,
  formatLiquidityCompact,
  formatWei,
  formatWeiCompact,
  shortAddress,
  txUrl,
} from './format'
import type { AnalyticsConfig } from '../types/content'
import type { DailyAggregate, EventsCollections, FrongAnalyticsArtifact } from './types'
import { useEstimatedPair } from './useEstimatedPair'
import { useFrongAnalytics } from './useFrongAnalytics'
import styles from './AnalyticsPage.module.css'

type Tone = 'exact' | 'measured' | 'estimated' | 'unavailable' | 'derived'

const TONE_LABELS: Record<Tone, string> = {
  exact: 'Exact — on-chain events',
  measured: 'Measured from exact events',
  derived: 'Derived — verified rate × exact volume',
  estimated: 'Estimated — external feed',
  unavailable: 'Unavailable',
}

function LabelBadge({ tone }: { tone: Tone }) {
  return (
    <span className={styles.badge} data-tone={tone}>
      <span className={styles.badgeDot} aria-hidden="true" />
      {TONE_LABELS[tone]}
    </span>
  )
}

const RANGE_OPTIONS = [
  { key: '24h', days: 1, label: '24h' },
  { key: '7d', days: 7, label: '7d' },
  { key: '30d', days: 30, label: '30d' },
  { key: 'all', days: 0, label: 'All' },
] as const

type RangeKey = (typeof RANGE_OPTIONS)[number]['key']

function RangeToggle({
  value,
  onChange,
}: {
  value: RangeKey
  onChange: (range: RangeKey) => void
}) {
  return (
    <div className={styles.ranges} role="group" aria-label="Chart time range">
      {RANGE_OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          className={styles.rangeButton}
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

interface SeriesToggleProps {
  series: { key: string; label: string; color: string }[]
  visible: Record<string, boolean>
  onToggle: (key: string) => void
  label: string
}

function SeriesToggles({ series, visible, onToggle, label }: SeriesToggleProps) {
  return (
    <div className={styles.seriesToggles} role="group" aria-label={label}>
      {series.map((item) => (
        <button
          key={item.key}
          type="button"
          className={styles.seriesToggle}
          aria-pressed={visible[item.key] !== false}
          onClick={() => onToggle(item.key)}
        >
          <span
            className={styles.seriesDot}
            style={{ background: item.color }}
            aria-hidden="true"
          />
          {item.label}
        </button>
      ))}
    </div>
  )
}

const HOUR_LABEL = (key: string): string => key.slice(11, 16) + ' UTC'
const EMPTY_DAILY: DailyAggregate = {
  date: '',
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

/** Map hourly swap rows into daily-shaped rows for the shared chart components. */
function hourlyToDaily(
  hourly: { hour: string; swaps: number; volEth: string; volFrong: string }[],
): DailyAggregate[] {
  return hourly.map((row) => ({
    ...EMPTY_DAILY,
    date: row.hour,
    swaps: row.swaps,
    volEth: row.volEth,
    volFrong: row.volFrong,
  }))
}

function rangeDays(
  daily: DailyAggregate[],
  range: RangeKey,
  hourly: DailyAggregate[],
): DailyAggregate[] {
  if (range === '24h') return hourly
  if (range === 'all') return daily
  return daily.slice(-RANGE_OPTIONS.find((option) => option.key === range)!.days)
}

function bigintOf(value: string | undefined): bigint {
  return BigInt(value ?? '0')
}

/** Sums of fee metrics inside a time window (exclusive end). */
function feeWindow(
  events: EventsCollections,
  end: number,
  seconds: number,
): { frong: bigint; eth: bigint; claims: number } {
  const start = end - seconds
  let frong = 0n
  let eth = 0n
  let claims = 0
  for (const event of events.feesCollected) {
    if (event.ts >= start && event.ts < end) {
      frong += bigintOf(event.frong)
      eth += bigintOf(event.eth)
      claims += 1
    }
  }
  return { frong, eth, claims }
}

function forwardWindow(
  events: EventsCollections,
  end: number,
  seconds: number,
  compound: boolean,
): { frong: bigint; eth: bigint } {
  const start = end - seconds
  const list = compound ? events.feesForwardedCompound : events.feesForwardedVault
  let frong = 0n
  let eth = 0n
  for (const event of list) {
    if (event.ts >= start && event.ts < end) {
      if (event.currency === 'FRONG') frong += bigintOf(event.amount)
      else eth += bigintOf(event.amount)
    }
  }
  return { frong, eth }
}

function liquidityWindow(
  events: EventsCollections,
  end: number,
  seconds: number,
): { adds: number; settlements: number } {
  const start = end - seconds
  let adds = 0
  let settlements = 0
  for (const event of events.modifyLiquidity) {
    if (event.ts >= start && event.ts < end) {
      const delta = bigintOf(event.delta)
      if (delta > 0n) adds += 1
      else if (delta === 0n) settlements += 1
    }
  }
  return { adds, settlements }
}

function swapWindow(
  hourly: { hour: string; swaps: number; volEth: string; volFrong: string }[],
  daily: DailyAggregate[],
  end: number,
  seconds: number,
): { volEth: bigint; volFrong: bigint; swaps: number } {
  const source = seconds <= 2 * 24 * 3600 ? hourly : daily
  return source.reduce(
    (acc, row) => {
      const key = 'hour' in row ? row.hour : row.date
      const ts = Date.parse(key) / 1000
      if (ts < end - seconds || ts >= end) return acc
      return {
        volEth: acc.volEth + bigintOf(row.volEth),
        volFrong: acc.volFrong + bigintOf(row.volFrong),
        swaps: acc.swaps + (row.swaps ?? 0),
      }
    },
    { volEth: 0n, volFrong: 0n, swaps: 0 },
  )
}

function deltaLabel(
  current: bigint,
  previous: bigint,
): { text: string; tone: 'up' | 'down' | 'flat' } {
  if (previous <= 0n) {
    return current > 0n ? { text: 'new', tone: 'flat' } : { text: '—', tone: 'flat' }
  }
  const diff = current - previous
  const pct = Number((diff * 10000n) / previous) / 100
  if (diff === 0n) return { text: '0%', tone: 'flat' }
  return diff > 0n
    ? { text: '+' + pct.toFixed(1) + '%', tone: 'up' }
    : { text: pct.toFixed(1) + '%', tone: 'down' }
}

interface KpiPair {
  current: bigint
  previous: bigint
}

interface KpiWindows {
  d24: KpiPair
  d7: KpiPair
  d30: KpiPair
}

function eventWindowPair(
  accessor: (events: EventsCollections, end: number, seconds: number) => bigint,
  events: EventsCollections,
  end: number,
  seconds: number,
): KpiPair {
  return {
    current: accessor(events, end, seconds),
    previous: accessor(events, end - seconds, seconds),
  }
}

function swapWindowPair(
  hourly: { hour: string; swaps: number; volEth: string; volFrong: string }[],
  daily: DailyAggregate[],
  end: number,
  seconds: number,
  pick: 'volFrong' | 'volEth' | 'swaps',
): KpiPair {
  const cur = swapWindow(hourly, daily, end, seconds)
  const prev = swapWindow(hourly, daily, end - seconds, seconds)
  return {
    current: BigInt(cur[pick]),
    previous: BigInt(prev[pick]),
  }
}

interface KpiDef {
  id: string
  title: string
  value: (artifact: FrongAnalyticsArtifact) => string
  sub: (artifact: FrongAnalyticsArtifact) => string
  badge: Tone
  windows: (artifact: FrongAnalyticsArtifact, end: number) => KpiWindows
}

const W24 = 24 * 3600
const W7 = 7 * 24 * 3600
const W30 = 30 * 24 * 3600

const KPIS: KpiDef[] = [
  {
    id: 'fees-frong',
    title: 'Fees collected · FRONG',
    value: (artifact) => formatWei(artifact.totals.feesCollectedFrong, 2) + ' FRONG',
    sub: (artifact) => artifact.totals.claims + ' claims',
    badge: 'exact',
    windows: (artifact, end) => {
      const accessor = (events: EventsCollections, e: number, s: number) =>
        feeWindow(events, e, s).frong
      return {
        d24: eventWindowPair(accessor, artifact.events, end, W24),
        d7: eventWindowPair(accessor, artifact.events, end, W7),
        d30: eventWindowPair(accessor, artifact.events, end, W30),
      }
    },
  },
  {
    id: 'fees-eth',
    title: 'Fees collected · ETH',
    value: (artifact) => formatWei(artifact.totals.feesCollectedEth, 4) + ' ETH',
    sub: () => 'native ETH side of the pool',
    badge: 'exact',
    windows: (artifact, end) => {
      const accessor = (events: EventsCollections, e: number, s: number) =>
        feeWindow(events, e, s).eth
      return {
        d24: eventWindowPair(accessor, artifact.events, end, W24),
        d7: eventWindowPair(accessor, artifact.events, end, W7),
        d30: eventWindowPair(accessor, artifact.events, end, W30),
      }
    },
  },
  {
    id: 'volume',
    title: 'Pool volume',
    value: (artifact) =>
      artifact.totals.volFrong ? formatWeiCompact(artifact.totals.volFrong, 2) + ' FRONG' : '—',
    sub: (artifact) =>
      artifact.totals.volEth ? formatWeiCompact(artifact.totals.volEth, 2) + ' ETH' : 'Unavailable',
    badge: 'exact',
    windows: (artifact, end) => {
      const hourly = artifact.swaps?.hourly ?? []
      const daily = artifact.daily
      return {
        d24: swapWindowPair(hourly, daily, end, W24, 'volFrong'),
        d7: swapWindowPair(hourly, daily, end, W7, 'volFrong'),
        d30: swapWindowPair(hourly, daily, end, W30, 'volFrong'),
      }
    },
  },
  {
    id: 'swaps',
    title: 'Swap count',
    value: (artifact) =>
      artifact.totals.swapCount !== undefined ? artifact.totals.swapCount.toLocaleString() : '—',
    sub: (artifact) => (artifact.swaps?.scan.completed ? 'exact swap events' : 'scan incomplete'),
    badge: 'exact',
    windows: (artifact, end) => {
      const hourly = artifact.swaps?.hourly ?? []
      const daily = artifact.daily
      return {
        d24: swapWindowPair(hourly, daily, end, W24, 'swaps'),
        d7: swapWindowPair(hourly, daily, end, W7, 'swaps'),
        d30: swapWindowPair(hourly, daily, end, W30, 'swaps'),
      }
    },
  },
  {
    id: 'compounded',
    title: 'Compounded back into liquidity',
    value: (artifact) => formatWei(artifact.totals.compoundedFrong, 2) + ' FRONG',
    sub: (artifact) => formatWei(artifact.totals.compoundedEth, 4) + ' ETH reinvested',
    badge: 'exact',
    windows: (artifact, end) => {
      const accessor = (events: EventsCollections, e: number, s: number) =>
        forwardWindow(events, e, s, true).frong
      return {
        d24: eventWindowPair(accessor, artifact.events, end, W24),
        d7: eventWindowPair(accessor, artifact.events, end, W7),
        d30: eventWindowPair(accessor, artifact.events, end, W30),
      }
    },
  },
  {
    id: 'forwarded',
    title: 'Forwarded to beneficiary',
    value: (artifact) => formatWei(artifact.totals.forwardedBeneficiaryEth, 4) + ' ETH',
    sub: (artifact) => formatWei(artifact.totals.forwardedBeneficiaryFrong, 2) + ' FRONG forwarded',
    badge: 'exact',
    windows: (artifact, end) => {
      const accessor = (events: EventsCollections, e: number, s: number) =>
        forwardWindow(events, e, s, false).eth
      return {
        d24: eventWindowPair(accessor, artifact.events, end, W24),
        d7: eventWindowPair(accessor, artifact.events, end, W7),
        d30: eventWindowPair(accessor, artifact.events, end, W30),
      }
    },
  },
  {
    id: 'liquidity',
    title: 'Position liquidity (net)',
    value: (artifact) => formatLiquidityCompact(artifact.totals.positionLiquidityNet) + ' L',
    sub: (artifact) =>
      artifact.totals.liquidityAdds +
      ' adds · ' +
      artifact.totals.feeSettlements +
      ' fee settlements · ' +
      artifact.totals.compounds +
      ' compound claims',
    badge: 'exact',
    windows: (artifact, end) => {
      const accessor = (events: EventsCollections, e: number, s: number) =>
        BigInt(liquidityWindow(events, e, s).adds)
      return {
        d24: eventWindowPair(accessor, artifact.events, end, W24),
        d7: eventWindowPair(accessor, artifact.events, end, W7),
        d30: eventWindowPair(accessor, artifact.events, end, W30),
      }
    },
  },
  {
    id: 'claimed',
    title: 'Beneficiary claims',
    value: (artifact) => formatWei(artifact.totals.vaultClaimedEth, 4) + ' ETH claimed',
    sub: (artifact) => 'beneficiary ' + shortAddress(artifact.scope.contracts.beneficiaryNftHolder),
    badge: 'exact',
    windows: (artifact, end) => {
      const list = artifact.events.vaultClaimed
      const window = (from: number, to: number) =>
        list
          .filter((event) => event.ts >= from && event.ts < to)
          .reduce((acc, event) => acc + bigintOf(event.eth), 0n)
      return {
        d24: { current: window(end - W24, end), previous: window(end - 2 * W24, end - W24) },
        d7: { current: window(end - W7, end), previous: window(end - 2 * W7, end - W7) },
        d30: { current: window(end - W30, end), previous: window(end - 2 * W30, end - W30) },
      }
    },
  },
]

function KpiCard({
  definition,
  artifact,
  end,
  visible,
}: {
  definition: KpiDef
  artifact: FrongAnalyticsArtifact
  end: number
  visible: boolean
}) {
  if (!visible) return null
  const windows = definition.windows(artifact, end)
  const d24 = deltaLabel(windows.d24.current, windows.d24.previous)
  const d7 = deltaLabel(windows.d7.current, windows.d7.previous)
  const d30 = deltaLabel(windows.d30.current, windows.d30.previous)
  return (
    <article className={styles.kpi}>
      <div className={styles.kpiHead}>
        <h3 className={styles.kpiTitle}>{definition.title}</h3>
        <LabelBadge tone={definition.badge} />
      </div>
      <p className={styles.kpiValue}>{definition.value(artifact)}</p>
      <p className={styles.kpiSub}>{definition.sub(artifact)}</p>
      <p className={styles.kpiDeltas}>
        <span data-tone={d24.tone}>24h {d24.text}</span>
        <span className={styles.deltaSpacer} aria-hidden="true">
          ·
        </span>
        <span data-tone={d7.tone}>7d {d7.text}</span>
        <span className={styles.deltaSpacer} aria-hidden="true">
          ·
        </span>
        <span data-tone={d30.tone}>30d {d30.text}</span>
      </p>
    </article>
  )
}

function UnavailableCard({ title, note }: { title: string; note: string }) {
  return (
    <div className={styles.unavailableCard} role="status">
      <LabelBadge tone="unavailable" />
      <h3 className={styles.panelTitle}>{title}</h3>
      <p>{note}</p>
    </div>
  )
}

export function AnalyticsPage({ analytics }: { analytics: AnalyticsConfig }) {
  const { status, artifact, error, reload } = useFrongAnalytics()
  const { pair, reload: reloadPair } = useEstimatedPair()
  const [activityRange, setActivityRange] = useState<RangeKey>('30d')
  const [feeRange, setFeeRange] = useState<RangeKey>('30d')
  const [shareRange, setShareRange] = useState<RangeKey>('30d')
  const [liquidityRange, setLiquidityRange] = useState<RangeKey>('all')
  const [feeUnit, setFeeUnit] = useState<'FRONG' | 'ETH'>('FRONG')
  const [shareUnit, setShareUnit] = useState<'FRONG' | 'ETH'>('FRONG')
  const [activitySeries, setActivitySeries] = useState<Record<string, boolean>>({
    swaps: true,
    volFrong: true,
    volEth: true,
  })
  const [feeSeries, setFeeSeries] = useState<Record<string, boolean>>({
    collected: true,
    forwardedVault: true,
    compounded: true,
    claimed: true,
  })
  const [liquiditySeries, setLiquiditySeries] = useState<Record<string, boolean>>({
    line: true,
    adds: true,
    settlements: true,
  })
  const [hiddenKpis, setHiddenKpis] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('frong-analytics-kpis')
      return stored ? (JSON.parse(stored) as string[]) : []
    } catch {
      return []
    }
  })
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem('frong-analytics-kpis', JSON.stringify(hiddenKpis))
    } catch {
      /* storage unavailable - in-memory only */
    }
  }, [hiddenKpis])

  const swapComplete = artifact?.swaps?.scan.completed === true
  const end = artifact?.asOf.timestamp ?? Math.floor(Date.now() / 1000)
  const hourly = useMemo(
    () => hourlyToDaily(artifact?.swaps?.hourly ?? []),
    [artifact?.swaps?.hourly],
  )

  const activityDays = rangeDays(artifact?.daily ?? [], activityRange, hourly)
  const feeDays = rangeDays(artifact?.daily ?? [], feeRange, hourly)
  const shareDays = rangeDays(artifact?.daily ?? [], shareRange, hourly)
  const liquidityDays = rangeDays(artifact?.daily ?? [], liquidityRange, hourly)
  const activityLabel = activityRange === '24h' ? HOUR_LABEL : undefined
  const feeLabel = feeRange === '24h' ? HOUR_LABEL : undefined
  const shareLabel = shareRange === '24h' ? HOUR_LABEL : undefined
  const liquidityLabel = liquidityRange === '24h' ? HOUR_LABEL : undefined

  const poolFees = useMemo(() => {
    if (!swapComplete || !artifact?.totals.volEth || !artifact?.totals.volFrong) return null
    return derivePoolFees(artifact.totals.volEth, artifact.totals.volFrong)
  }, [swapComplete, artifact?.totals.volEth, artifact?.totals.volFrong])

  const claimedByDay = useMemo(() => {
    const rows = new Map<string, { eth: bigint; frong: bigint }>()
    for (const event of artifact?.events.vaultClaimed ?? []) {
      const date = new Date(event.ts * 1000).toISOString().slice(0, 10)
      const current = rows.get(date) ?? { eth: 0n, frong: 0n }
      current.eth += bigintOf(event.eth)
      current.frong += bigintOf(event.frong)
      rows.set(date, current)
    }
    return rows
  }, [artifact?.events.vaultClaimed])

  return (
    <section id="analytics" className={styles.page} aria-labelledby="analytics-title">
      <div className="container">
        <p className={styles.backRow}>
          <a className={styles.backLink} href="/">
            ← Back to home
          </a>
        </p>
        <p className="eyebrow">{analytics.eyebrow}</p>
        <h1 className={styles.title} id="analytics-title" tabIndex={-1} ref={titleRef}>
          {analytics.title}
        </h1>
        <p className={styles.lede}>{analytics.lede}</p>

        {status === 'loading' ? (
          <div className={styles.state} role="status">
            <p>Loading on-chain fee history…</p>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className={styles.state} role="alert">
            <p className={styles.stateTitle}>Analytics data could not be loaded.</p>
            <p>{error}</p>
            <button type="button" className={styles.retryButton} onClick={reload}>
              Retry
            </button>
          </div>
        ) : null}

        {status === 'empty' && artifact ? (
          <div className={styles.state}>
            <p className={styles.stateTitle}>No fee events recorded yet.</p>
            <p>
              The artifact at block {artifact.asOf.block.toLocaleString()} contains no events for
              this position. Nothing is fabricated — check back after the next claim.
            </p>
          </div>
        ) : null}

        {(status === 'ready' || status === 'stale') && artifact ? (
          <div className={styles.shell}>
            <div className={styles.statusStrip}>
              <div className={styles.statusBadges}>
                <LabelBadge tone="exact" />
                <LabelBadge tone="measured" />
                <LabelBadge tone="derived" />
                <LabelBadge tone="estimated" />
                <LabelBadge tone="unavailable" />
              </div>
              <p className={styles.asOf}>
                As of block <strong>{artifact.asOf.block.toLocaleString()}</strong> ·{' '}
                {formatDateTime(artifact.asOf.timestamp)} UTC
                {swapComplete ? (
                  <>
                    {' '}
                    · swap scan{' '}
                    <strong>
                      {artifact.swaps?.scan.fromBlock.toLocaleString()}–
                      {artifact.swaps?.scan.toBlock.toLocaleString()}
                    </strong>{' '}
                    complete
                  </>
                ) : (
                  <> · swap scan incomplete — volume unavailable</>
                )}
              </p>
            </div>

            <section aria-label="Key metrics">
              <details className={styles.cardManager}>
                <summary>Show / hide cards</summary>
                <div className={styles.cardChecks} role="group" aria-label="Visible cards">
                  {KPIS.map((definition) => {
                    const hidden = hiddenKpis.includes(definition.id)
                    return (
                      <label key={definition.id} className={styles.cardCheck}>
                        <input
                          type="checkbox"
                          checked={!hidden}
                          onChange={() =>
                            setHiddenKpis((previous) =>
                              hidden
                                ? previous.filter((id) => id !== definition.id)
                                : [...previous, definition.id],
                            )
                          }
                        />
                        {definition.title}
                      </label>
                    )
                  })}
                </div>
              </details>
              <div className={styles.kpiGrid}>
                {KPIS.map((definition) => (
                  <KpiCard
                    key={definition.id}
                    definition={definition}
                    artifact={artifact}
                    end={end}
                    visible={!hiddenKpis.includes(definition.id)}
                  />
                ))}
              </div>
            </section>

            <section className={styles.chartCard} aria-label="Pool activity">
              <div className={styles.chartHead}>
                <h2 className={styles.panelTitle}>Pool activity</h2>
                <RangeToggle value={activityRange} onChange={setActivityRange} />
              </div>
              <SeriesToggles
                label="Activity series"
                visible={activitySeries}
                onToggle={(key) =>
                  setActivitySeries((previous) => ({ ...previous, [key]: previous[key] === false }))
                }
                series={[
                  { key: 'swaps', label: 'Swap count', color: 'var(--accent)' },
                  { key: 'volFrong', label: 'FRONG volume', color: 'var(--accent)' },
                  { key: 'volEth', label: 'ETH volume', color: 'var(--info)' },
                ]}
              />
              {!swapComplete ? (
                <UnavailableCard
                  title="Swap activity & volume"
                  note="The swap scan has not completed without gaps, so partial totals are intentionally not shown. Re-run npm run analytics:update to complete it."
                />
              ) : (
                <div className={styles.paneGrid}>
                  {activitySeries.swaps ? (
                    <div className={styles.pane}>
                      <h3 className={styles.paneTitle}>Swap count · exact</h3>
                      <StackedBarChart
                        days={activityDays}
                        labelFor={activityLabel}
                        ariaLabel={
                          'Exact daily swap count for the FRONG/ETH pool over ' +
                          activityDays.length +
                          ' rows'
                        }
                        series={[
                          {
                            key: 'swaps',
                            label: 'swaps',
                            color: 'var(--accent)',
                            value: (day) => String(day.swaps ?? 0),
                            format: (value) => value + ' swaps',
                          },
                        ]}
                      />
                    </div>
                  ) : null}
                  {activitySeries.volFrong ? (
                    <div className={styles.pane}>
                      <h3 className={styles.paneTitle}>FRONG volume · exact token units</h3>
                      <StackedBarChart
                        days={activityDays}
                        labelFor={activityLabel}
                        ariaLabel={
                          'Exact FRONG swap volume per day, totaling ' +
                          formatWeiCompact(artifact.totals.volFrong ?? '0', 2) +
                          ' FRONG'
                        }
                        series={[
                          {
                            key: 'volFrong',
                            label: 'FRONG',
                            color: 'var(--accent)',
                            value: (day) => day.volFrong ?? '0',
                          },
                        ]}
                      />
                    </div>
                  ) : null}
                  {activitySeries.volEth ? (
                    <div className={styles.pane}>
                      <h3 className={styles.paneTitle}>ETH volume · exact token units</h3>
                      <StackedBarChart
                        days={activityDays}
                        labelFor={activityLabel}
                        ariaLabel={
                          'Exact ETH swap volume per day, totaling ' +
                          formatWeiCompact(artifact.totals.volEth ?? '0', 2) +
                          ' ETH'
                        }
                        series={[
                          {
                            key: 'volEth',
                            label: 'ETH',
                            color: 'var(--info)',
                            value: (day) => day.volEth ?? '0',
                          },
                        ]}
                      />
                    </div>
                  ) : null}
                </div>
              )}
              <ChartDataTable
                caption="Pool activity data"
                days={activityDays}
                columns={['Day', 'Swaps', 'FRONG volume', 'ETH volume']}
                renderRow={(day) => [
                  day.date,
                  String(day.swaps ?? 0),
                  formatWeiCompact(day.volEth ?? '0', 4),
                  formatWeiCompact(day.volFrong ?? '0', 4),
                ]}
              />
            </section>

            <section className={styles.chartCard} aria-label="Fee flow">
              <div className={styles.chartHead}>
                <h2 className={styles.panelTitle}>Fee flow: collected → forwarded → claimed</h2>
                <div className={styles.unitToggle} role="group" aria-label="Fee flow currency">
                  <button
                    type="button"
                    className={styles.unitButton}
                    aria-pressed={feeUnit === 'FRONG'}
                    onClick={() => setFeeUnit('FRONG')}
                  >
                    FRONG
                  </button>
                  <button
                    type="button"
                    className={styles.unitButton}
                    aria-pressed={feeUnit === 'ETH'}
                    onClick={() => setFeeUnit('ETH')}
                  >
                    ETH
                  </button>
                </div>
                <RangeToggle value={feeRange} onChange={setFeeRange} />
              </div>
              <SeriesToggles
                label="Fee flow series"
                visible={feeSeries}
                onToggle={(key) =>
                  setFeeSeries((previous) => ({ ...previous, [key]: previous[key] === false }))
                }
                series={[
                  { key: 'collected', label: 'Collected', color: 'var(--accent)' },
                  {
                    key: 'forwardedVault',
                    label: 'Forwarded to beneficiary',
                    color: 'var(--success)',
                  },
                  { key: 'compounded', label: 'Compounded', color: 'var(--info)' },
                  { key: 'claimed', label: 'Beneficiary claimed', color: 'var(--warning)' },
                ]}
              />
              <GroupedBarChart
                days={feeDays}
                labelFor={feeLabel}
                ariaLabel={
                  'Fee flow per day in ' +
                  feeUnit +
                  ': collected, forwarded to beneficiary, compounded, and beneficiary claims'
                }
                series={[
                  ...(feeSeries.collected
                    ? [
                        {
                          key: 'collected',
                          label: 'Collected',
                          color: 'var(--accent)',
                          value: (day: DailyAggregate) =>
                            feeUnit === 'FRONG' ? day.feesCollectedFrong : day.feesCollectedEth,
                        },
                      ]
                    : []),
                  ...(feeSeries.forwardedVault
                    ? [
                        {
                          key: 'forwardedVault',
                          label: 'Forwarded to beneficiary',
                          color: 'var(--success)',
                          value: (day: DailyAggregate) =>
                            feeUnit === 'FRONG' ? day.forwardedVaultFrong : day.forwardedVaultEth,
                        },
                      ]
                    : []),
                  ...(feeSeries.compounded
                    ? [
                        {
                          key: 'compounded',
                          label: 'Compounded',
                          color: 'var(--info)',
                          value: (day: DailyAggregate) =>
                            feeUnit === 'FRONG' ? day.compoundedFrong : day.compoundedEth,
                        },
                      ]
                    : []),
                  ...(feeSeries.claimed
                    ? [
                        {
                          key: 'claimed',
                          label: 'Beneficiary claimed',
                          color: 'var(--warning)',
                          value: (day: DailyAggregate) => {
                            const claimed = claimedByDay.get(day.date)
                            return feeUnit === 'FRONG'
                              ? (claimed?.frong ?? 0n).toString()
                              : (claimed?.eth ?? 0n).toString()
                          },
                        },
                      ]
                    : []),
                ]}
              />
              <p className={styles.chartHint}>
                {feeUnit === 'FRONG'
                  ? 'FRONG pane: 100% of collected FRONG is compounded; beneficiary forwarded FRONG is 0.'
                  : 'ETH pane: 40% forwarded to the beneficiary, 60% compounded (measured per claim, ±1 wei).'}
              </p>
              <ChartDataTable
                caption="Fee flow data"
                days={feeDays}
                columns={['Day', 'Collected', 'Forwarded', 'Compounded', 'Claimed']}
                renderRow={(day) => {
                  const claimed = claimedByDay.get(day.date)
                  return [
                    day.date,
                    feeUnit === 'FRONG'
                      ? formatWei(day.feesCollectedFrong, 2)
                      : formatWei(day.feesCollectedEth, 4),
                    feeUnit === 'FRONG'
                      ? formatWei(day.forwardedVaultFrong, 2)
                      : formatWei(day.forwardedVaultEth, 4),
                    feeUnit === 'FRONG'
                      ? formatWei(day.compoundedFrong, 2)
                      : formatWei(day.compoundedEth, 4),
                    feeUnit === 'FRONG'
                      ? formatWei((claimed?.frong ?? 0n).toString(), 2)
                      : formatWei((claimed?.eth ?? 0n).toString(), 4),
                  ]
                }}
              />
            </section>

            <section className={styles.chartCard} aria-label="Collected versus compounded share">
              <div className={styles.chartHead}>
                <h2 className={styles.panelTitle}>Collected vs compounded share</h2>
                <div className={styles.unitToggle} role="group" aria-label="Share currency">
                  <button
                    type="button"
                    className={styles.unitButton}
                    aria-pressed={shareUnit === 'FRONG'}
                    onClick={() => setShareUnit('FRONG')}
                  >
                    FRONG
                  </button>
                  <button
                    type="button"
                    className={styles.unitButton}
                    aria-pressed={shareUnit === 'ETH'}
                    onClick={() => setShareUnit('ETH')}
                  >
                    ETH
                  </button>
                </div>
                <RangeToggle value={shareRange} onChange={setShareRange} />
              </div>
              <LineChart
                days={shareDays}
                labelFor={shareLabel}
                domainMax="100"
                unitLabel="% compounded"
                formatPoint={(value) => value + '%'}
                color="var(--info)"
                value={(day) => {
                  const collected =
                    shareUnit === 'FRONG'
                      ? bigintOf(day.feesCollectedFrong)
                      : bigintOf(day.feesCollectedEth)
                  if (collected <= 0n) return '0'
                  const compounded =
                    shareUnit === 'FRONG'
                      ? bigintOf(day.compoundedFrong)
                      : bigintOf(day.compoundedEth)
                  return String((compounded * 100n) / collected)
                }}
                ariaLabel={
                  'Normalized compounded share of collected fees per day in ' +
                  shareUnit +
                  ' (0-100 percent)'
                }
              />
              <p className={styles.chartHint}>
                {shareUnit === 'FRONG'
                  ? 'FRONG: ~100% of collected fees are reinvested every claim.'
                  : 'ETH: ~60% of collected fees are reinvested every claim (40% to the beneficiary).'}
              </p>
            </section>

            <section className={styles.chartCard} aria-label="Position liquidity">
              <div className={styles.chartHead}>
                <h2 className={styles.panelTitle}>Position liquidity growth</h2>
                <RangeToggle value={liquidityRange} onChange={setLiquidityRange} />
              </div>
              <SeriesToggles
                label="Liquidity series"
                visible={liquiditySeries}
                onToggle={(key) =>
                  setLiquiditySeries((previous) => ({
                    ...previous,
                    [key]: previous[key] === false,
                  }))
                }
                series={[
                  { key: 'line', label: 'Liquidity (L)', color: 'var(--accent)' },
                  { key: 'adds', label: 'Liquidity adds', color: 'var(--success)' },
                  { key: 'settlements', label: 'Fee settlements', color: 'var(--info)' },
                ]}
              />
              {liquiditySeries.line ? (
                <LineChart
                  days={liquidityDays}
                  labelFor={liquidityLabel}
                  value={(day) => day.liquidityAtEnd}
                  unitLabel="liquidity units"
                  color="var(--accent)"
                  ariaLabel={
                    'Cumulative concentrated liquidity of position ' +
                    artifact.scope.position.tokenId +
                    ' ending at ' +
                    formatLiquidity(artifact.totals.positionLiquidityNet) +
                    ' liquidity units'
                  }
                />
              ) : null}
              <div className={styles.paneGrid}>
                {liquiditySeries.adds ? (
                  <div className={styles.pane}>
                    <h3 className={styles.paneTitle}>Liquidity adds per day</h3>
                    <StackedBarChart
                      days={liquidityDays}
                      labelFor={liquidityLabel}
                      ariaLabel="Liquidity adds (compounds) per day"
                      series={[
                        {
                          key: 'adds',
                          label: 'adds',
                          color: 'var(--success)',
                          value: (day) => String(day.liquidityAdds),
                          format: (value) => value + ' adds',
                        },
                      ]}
                    />
                  </div>
                ) : null}
                {liquiditySeries.settlements ? (
                  <div className={styles.pane}>
                    <h3 className={styles.paneTitle}>Fee settlements per day</h3>
                    <StackedBarChart
                      days={liquidityDays}
                      labelFor={liquidityLabel}
                      ariaLabel="Zero-delta fee settlements per day"
                      series={[
                        {
                          key: 'settlements',
                          label: 'settlements',
                          color: 'var(--info)',
                          value: (day) => String(day.feeSettlements),
                          format: (value) => value + ' settlements',
                        },
                      ]}
                    />
                  </div>
                ) : null}
              </div>
              <ChartDataTable
                caption="Liquidity data"
                days={liquidityDays}
                columns={['Day', 'Adds', 'Fee settlements', 'Liquidity at end of day']}
                renderRow={(day) => [
                  day.date,
                  String(day.liquidityAdds),
                  String(day.feeSettlements),
                  formatLiquidity(day.liquidityAtEnd),
                ]}
              />
            </section>

            <section className={styles.chartCard} aria-label="Pool versus position fee share">
              <h2 className={styles.panelTitle}>Pool vs position fee share</h2>
              {!poolFees ? (
                <UnavailableCard
                  title="Fee share unavailable"
                  note="Requires the completed swap scan (exact volume × the verified 0.25% static LP fee). Partial totals are never shown."
                />
              ) : (
                <>
                  <div className={styles.shareGrid}>
                    <div className={styles.shareCell}>
                      <p className={styles.shareValue}>
                        {positionFeeShare(
                          bigintOf(artifact.totals.feesCollectedFrong),
                          bigintOf(poolFees.lpFeeFrong),
                        ) ?? '—'}
                        %
                      </p>
                      <p className={styles.shareLabel}>
                        FRONG: position collected{' '}
                        {formatWeiCompact(artifact.totals.feesCollectedFrong, 2)} of pool LP fees{' '}
                        {formatWeiCompact(poolFees.lpFeeFrong, 2)}
                      </p>
                    </div>
                    <div className={styles.shareCell}>
                      <p className={styles.shareValue}>
                        {positionFeeShare(
                          bigintOf(artifact.totals.feesCollectedEth),
                          bigintOf(poolFees.lpFeeEth),
                        ) ?? '—'}
                        %
                      </p>
                      <p className={styles.shareLabel}>
                        ETH: position collected{' '}
                        {formatWeiCompact(artifact.totals.feesCollectedEth, 2)} of pool LP fees{' '}
                        {formatWeiCompact(poolFees.lpFeeEth, 2)}
                      </p>
                    </div>
                  </div>
                  <p className={styles.chartHint}>
                    <LabelBadge tone="derived" /> pool LP fees = exact volume × verified 0.25%
                    static LP fee. Protocol fee (0.04%) is excluded. The Swap event&apos;s trailing
                    rate word ({SWAP_FEE_WORD_OBSERVED}) is NOT used — its fork semantics are not
                    pinned.
                  </p>
                </>
              )}
            </section>

            <section className={styles.chartCard} aria-label="Estimated market snapshot">
              <div className={styles.chartHead}>
                <h2 className={styles.panelTitle}>Estimated market snapshot</h2>
                {pair.status === 'error' ? (
                  <button type="button" className={styles.retryButton} onClick={reloadPair}>
                    Retry feed
                  </button>
                ) : null}
              </div>
              <div className={styles.estimatedStrip}>
                <LabelBadge tone="estimated" />
                <span className={styles.estimatedMeta}>
                  {pair.source}
                  {pair.fetchedAt ? ' · fetched ' + formatDateTime(pair.fetchedAt) + ' UTC' : ''}
                </span>
                {pair.status === 'loading' ? (
                  <p className={styles.estimatedValue} role="status">
                    Loading external feed…
                  </p>
                ) : null}
                {pair.status === 'error' ? (
                  <p className={styles.estimatedValue} role="status">
                    External feed unavailable — no USD values are invented.
                  </p>
                ) : null}
                {pair.status === 'ready' ? (
                  <div className={styles.estimatedGrid}>
                    <div className={styles.shareCell}>
                      <p className={styles.shareValue}>
                        {pair.priceUsd ? '$' + Number(pair.priceUsd).toFixed(5) : '—'}
                      </p>
                      <p className={styles.shareLabel}>FRONG price (USD)</p>
                    </div>
                    <div className={styles.shareCell}>
                      <p className={styles.shareValue}>
                        {pair.volume24hUsd ? '$' + formatLiquidityCompact(pair.volume24hUsd) : '—'}
                      </p>
                      <p className={styles.shareLabel}>24h volume (USD, feed methodology)</p>
                    </div>
                    <div className={styles.shareCell}>
                      <p className={styles.shareValue}>
                        {pair.liquidityUsd ? '$' + formatLiquidityCompact(pair.liquidityUsd) : '—'}
                      </p>
                      <p className={styles.shareLabel}>Pool liquidity (USD)</p>
                    </div>
                  </div>
                ) : null}
                <p className={styles.chartHint}>
                  Display only. Estimated values never feed the exact totals above, which come
                  exclusively from on-chain events and the verified 0.25% static fee.
                </p>
              </div>
            </section>

            <section className={styles.chartCard} aria-label="Recent events">
              <h2 className={styles.panelTitle}>Recent events</h2>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className="visually-hidden">
                    Recent fee and liquidity events for position {artifact.scope.position.tokenId}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Time (UTC)</th>
                      <th scope="col">Event</th>
                      <th scope="col">FRONG</th>
                      <th scope="col">ETH</th>
                      <th scope="col">Liquidity Δ</th>
                      <th scope="col">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {artifact.recent.map((event) => {
                      const frong = event.frong !== '0' ? formatWei(event.frong, 2) : '—'
                      const eth = event.eth !== '0' ? formatWei(event.eth, 4) : '—'
                      const delta = event.delta !== '0' ? formatLiquidityCompact(event.delta) : '—'
                      return (
                        <tr key={event.txHash + '|' + event.logIndex}>
                          <td>{formatDateTime(event.ts)}</td>
                          <td>
                            <span className={styles.eventKind} data-kind={event.kind}>
                              {event.title}
                            </span>
                          </td>
                          <td className={styles.num}>{frong}</td>
                          <td className={styles.num}>{eth}</td>
                          <td className={styles.num}>{delta}</td>
                          <td>
                            <a
                              className={styles.txLink}
                              href={txUrl(artifact.chain.explorerTxUrlTemplate, event.txHash)}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {shortAddress(event.txHash, 6)}
                              <span className="visually-hidden"> (opens in a new tab)</span>
                            </a>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className={styles.provenance} aria-label="Data provenance">
              <h2 className={styles.panelTitle}>Provenance &amp; labels</h2>
              <ul className={styles.provenanceList}>
                <li>
                  <LabelBadge tone="exact" /> values come directly from on-chain event logs
                  (FeesCollected, FeesForwarded, AmountsReceived, Claimed, ModifyLiquidity, Swap).
                </li>
                <li>
                  <LabelBadge tone="measured" /> the ETH 40/60 and FRONG 100% split is measured from
                  the events themselves (±1 wei rounding dust per claim).
                </li>
                <li>
                  <LabelBadge tone="derived" /> pool LP fees = exact swap volume × the verified
                  0.25% static pool fee. The 0.2% figure is never treated as a fee rate anywhere.
                </li>
                <li>
                  <LabelBadge tone="estimated" /> USD figures come from the DexScreener feed with a
                  source and fetchedAt; they never feed exact totals.
                </li>
                <li>
                  <LabelBadge tone="unavailable" /> anything without a completed scan or a verified
                  rate stays unavailable — partial totals are never shown.
                </li>
              </ul>
              <dl className={styles.addressGrid}>
                <AddressRow
                  label="FRONG token"
                  value={artifact.scope.token.address}
                  artifact={artifact}
                />
                <AddressRow
                  label="Pool (FRONG/ETH)"
                  value={artifact.scope.pool.id}
                  artifact={artifact}
                />
                <AddressRow
                  label="PoolManager"
                  value={artifact.scope.contracts.poolManager}
                  artifact={artifact}
                />
                <AddressRow
                  label="PositionManager"
                  value={artifact.scope.contracts.positionManager}
                  artifact={artifact}
                />
                <AddressRow
                  label="FeeSplitter"
                  value={artifact.scope.contracts.feeSplitter}
                  artifact={artifact}
                />
                <AddressRow
                  label="Beneficiary vault"
                  value={artifact.scope.contracts.beneficiaryVault}
                  artifact={artifact}
                />
                <AddressRow
                  label="Beneficiary NFT holder"
                  value={artifact.scope.contracts.beneficiaryNftHolder}
                  artifact={artifact}
                />
                <AddressRow
                  label="Compounding recipient"
                  value={artifact.scope.contracts.compoundingRecipient}
                  artifact={artifact}
                />
              </dl>
              <p className={styles.provenanceNote}>
                Chain: {artifact.chain.name} (chain id {artifact.chain.chainId}) · data source:{' '}
                {artifact.rpc} · explorer: robinhoodchain.blockscout.com · artifact schema v
                {artifact.schemaVersion}, generated {artifact.generatedAt} · processed through block{' '}
                {artifact.cursor.lastProcessedBlock.toLocaleString()} · swap scan:{' '}
                {artifact.swaps
                  ? artifact.swaps.scan.completed
                    ? 'completed (' +
                      artifact.swaps.scan.swapCount.toLocaleString() +
                      ' swaps, fetched ' +
                      artifact.swaps.scan.fetchedAt +
                      ')'
                    : 'INCOMPLETE'
                  : 'absent (v1 artifact)'}{' '}
                · refresh with <code>npm run analytics:update</code> (read-only, incremental).
              </p>
            </section>
          </div>
        ) : null}

        {status === 'stale' && artifact ? (
          <div className={styles.staleNote} role="status">
            Data shown is as of block {artifact.asOf.block.toLocaleString()} (
            {formatDateTime(artifact.asOf.timestamp)} UTC) and is older than 24 hours. Run{' '}
            <code>npm run analytics:update</code> to refresh it.
          </div>
        ) : null}
      </div>
    </section>
  )
}

function AddressRow({
  label,
  value,
  artifact,
}: {
  label: string
  value: string
  artifact: FrongAnalyticsArtifact
}) {
  const addressBase = artifact.chain.explorerTxUrlTemplate.replace('/tx/{tx}', '/address/')
  return (
    <div className={styles.addressRow}>
      <dt className={styles.addressLabel}>{label}</dt>
      <dd className={styles.addressValue}>
        <a href={addressBase + value} target="_blank" rel="noreferrer noopener">
          {shortAddress(value, 8)}
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      </dd>
    </div>
  )
}
