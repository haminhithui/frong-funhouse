/**
 * Dependency-free, accessible charts for the analytics dashboard.
 * Bar charts are HTML/CSS (fully readable, hoverable, keyboard-focusable via
 * their data tables); the liquidity line chart is a small SVG with per-point
 * titles and an aria-label. All charts render static snapshots - no animation
 * (prefers-reduced-motion friendly by default).
 */
import type { DailyAggregate } from './types'
import { formatDayLabel, formatWeiCompact } from './format'

export interface BarSeries {
  key: string
  label: string
  color: string
  /** wei string per day */
  value: (day: DailyAggregate) => string
  /** formats the per-bar tooltip value; defaults to compact wei */
  format?: (value: string) => string
}

interface BarChartProps {
  days: DailyAggregate[]
  series: BarSeries[]
  /** Human summary announced to screen readers. */
  ariaLabel: string
  /** Axis label formatter (e.g. hour labels for the 24h view). */
  labelFor?: (key: string) => string
}

function scaleCeil(value: bigint): bigint {
  if (value <= 0n) return 1n
  const str = value.toString()
  const magnitude = 10n ** BigInt(str.length - 1)
  const steps = [1n, 2n, 3n, 4n, 5n, 6n, 8n, 10n].map((s) => s * magnitude)
  for (const step of steps) {
    if (step >= value) return step
  }
  return steps[steps.length - 1] * 2n
}

export function StackedBarChart({ days, series, ariaLabel, labelFor }: BarChartProps) {
  const perDayTotals = days.map((day) => series.reduce((acc, s) => acc + BigInt(s.value(day)), 0n))
  const maxTotal = perDayTotals.reduce((acc, v) => (v > acc ? v : acc), 0n)
  const ceil = scaleCeil(maxTotal)
  const label = labelFor ?? formatDayLabel
  return (
    <figure className="frong-chart" role="img" aria-label={ariaLabel}>
      <div className="frong-chart__bars" aria-hidden="true">
        {days.map((day, index) => {
          const total = perDayTotals[index]
          const segments = series.map((s) => ({
            label: s.label,
            color: s.color,
            height: total === 0n ? 0 : Number((BigInt(s.value(day)) * 10000n) / ceil) / 100,
          }))
          return (
            <div
              key={day.date}
              className="frong-chart__column"
              title={
                day.date +
                ' · ' +
                series
                  .map((s) => (s.format ?? ((v: string) => formatWeiCompact(v, 4)))(s.value(day)))
                  .join(' + ')
              }
            >
              <div className="frong-chart__stack">
                {segments.map((segment, segmentIndex) =>
                  segment.height > 0 ? (
                    <div
                      key={segmentIndex}
                      className="frong-chart__segment"
                      style={{ height: segment.height + '%', background: segment.color }}
                    />
                  ) : null,
                )}
              </div>
            </div>
          )
        })}
      </div>
      <figcaption className="frong-chart__axis" aria-hidden="true">
        <span>{days.length > 0 ? label(days[0].date) : '—'}</span>
        <span>{days.length > 0 ? label(days[days.length - 1].date) : '—'}</span>
      </figcaption>
    </figure>
  )
}

interface LineChartProps {
  days: DailyAggregate[]
  value: (day: DailyAggregate) => string
  ariaLabel: string
  color: string
  /** unit shown in point titles */
  unitLabel: string
  /** fixed domain ceiling (e.g. '100' for percent charts) */
  domainMax?: string
  /** formats point-tooltip values (defaults to compact wei) */
  formatPoint?: (value: string) => string
  /** Axis label formatter (e.g. hour labels for the 24h view). */
  labelFor?: (key: string) => string
}

export function LineChart({
  days,
  value,
  ariaLabel,
  color,
  unitLabel,
  domainMax,
  formatPoint,
  labelFor,
}: LineChartProps) {
  const width = 720
  const height = 200
  const pad = 8
  const values = days.map((day) => BigInt(value(day)))
  const max = values.reduce((acc, v) => (v > acc ? v : acc), 0n)
  const ceil = domainMax ? BigInt(domainMax) : scaleCeil(max)
  const label = labelFor ?? formatDayLabel
  const points =
    days.length > 1
      ? values.map((v, index) => {
          const x = pad + (index * (width - pad * 2)) / (days.length - 1)
          const y = height - pad - Number((v * BigInt(height - pad * 2)) / ceil)
          return [x, y] as const
        })
      : []
  const path = points
    .map(([x, y], i) => (i === 0 ? 'M' + x + ' ' + y : 'L' + x + ' ' + y))
    .join(' ')
  const area =
    points.length > 0
      ? path +
        ' L' +
        points[points.length - 1][0] +
        ' ' +
        (height - pad) +
        ' L' +
        points[0][0] +
        ' ' +
        (height - pad) +
        ' Z'
      : ''
  return (
    <figure className="frong-chart" role="img" aria-label={ariaLabel}>
      <svg
        viewBox={'0 0 ' + width + ' ' + height}
        width="100%"
        role="presentation"
        focusable="false"
        aria-hidden="true"
      >
        {area ? <path d={area} fill={color} opacity="0.12" /> : null}
        {path ? (
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {points.map(([x, y], index) => (
          <circle key={days[index].date} cx={x} cy={y} r="2.5" fill={color}>
            <title>
              {label(days[index].date)} ·{' '}
              {(formatPoint ?? ((v: string) => formatWeiCompact(v, 4)))(value(days[index]))}{' '}
              {unitLabel}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption className="frong-chart__axis" aria-hidden="true">
        <span>{days.length > 0 ? label(days[0].date) : '—'}</span>
        <span>{days.length > 0 ? label(days[days.length - 1].date) : '—'}</span>
      </figcaption>
    </figure>
  )
}

/**
 * Grouped (side-by-side, never stacked) bar chart for one currency pane.
 * All series share one unit and one scale; each day renders one bar per
 * visible series so no two units ever share an axis.
 */
export function GroupedBarChart({
  days,
  series,
  ariaLabel,
  labelFor,
}: {
  days: DailyAggregate[]
  series: BarSeries[]
  ariaLabel: string
  labelFor?: (key: string) => string
}) {
  const all = days.flatMap((day) => series.map((s) => BigInt(s.value(day))))
  const max = all.reduce((acc, v) => (v > acc ? v : acc), 0n)
  const ceil = scaleCeil(max)
  const groupWidth = series.length
  const label = labelFor ?? formatDayLabel
  return (
    <figure className="frong-chart" role="img" aria-label={ariaLabel}>
      <div className="frong-chart__bars" aria-hidden="true">
        {days.map((day) => (
          <div
            key={day.date}
            className="frong-chart__column frong-chart__column--grouped"
            title={
              day.date +
              ' · ' +
              series
                .map(
                  (s) =>
                    s.label +
                    ': ' +
                    (s.format ?? ((v: string) => formatWeiCompact(v, 4)))(s.value(day)),
                )
                .join(' · ')
            }
          >
            {series.map((s) => {
              const height = max === 0n ? 0 : Number((BigInt(s.value(day)) * 10000n) / ceil) / 100
              return (
                <div
                  key={s.key}
                  className="frong-chart__group-slot"
                  style={{ width: 100 / groupWidth + '%' }}
                >
                  {height > 0 ? (
                    <div
                      className="frong-chart__segment frong-chart__segment--grouped"
                      style={{ height: height + '%', background: s.color }}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <figcaption className="frong-chart__axis" aria-hidden="true">
        <span>{days.length > 0 ? label(days[0].date) : '—'}</span>
        <span>{days.length > 0 ? label(days[days.length - 1].date) : '—'}</span>
      </figcaption>
    </figure>
  )
}

/** Accessible data-table disclosure that backs every chart. */
export function ChartDataTable({
  caption,
  days,
  renderRow,
  columns,
}: {
  caption: string
  days: DailyAggregate[]
  columns: string[]
  renderRow: (day: DailyAggregate) => string[]
}) {
  return (
    <details className="frong-chart__data">
      <summary>View data table</summary>
      <div className="frong-table-wrap">
        <table className="frong-table frong-table--compact">
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((day) => (
              <tr key={day.date}>
                {renderRow(day).map((cell, index) => (
                  <td key={index}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
