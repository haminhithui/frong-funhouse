/**
 * Display formatting for the analytics dashboard. All amounts are decimal
 * strings in wei (18 decimals for FRONG and native ETH) or raw liquidity
 * units; formatting is pure and never mutates data.
 */

const WEI_DECIMALS = 18

function groupThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Format a decimal string with fixed decimals as a human-readable number. */
export function formatBigDecimal(value: string, decimals: number, maxFrac: number): string {
  const negative = value.startsWith('-')
  const abs = negative ? value.slice(1) : value
  const padded = abs.padStart(decimals + 1, '0')
  const intPart = padded.slice(0, padded.length - decimals) || '0'
  let frac = padded.slice(padded.length - decimals).slice(0, maxFrac)
  frac = frac.replace(/0+$/, '')
  const grouped = groupThousands(intPart)
  return (negative ? '-' : '') + grouped + (frac ? '.' + frac : '')
}

/** Format a wei amount (18 decimals) with up to maxFrac decimals. */
export function formatWei(wei: string, maxFrac = 4): string {
  return formatBigDecimal(wei, WEI_DECIMALS, maxFrac)
}

/**
 * Compact wei display: "1.23M" style, purely string-based so huge values
 * never lose precision to Number. Whole-token magnitudes only.
 */
export function formatWeiCompact(wei: string, maxFrac = 2): string {
  const negative = wei.startsWith('-')
  const abs = negative ? wei.slice(1) : wei
  const whole = abs.length > WEI_DECIMALS ? abs.slice(0, abs.length - WEI_DECIMALS) : ''
  const frac = (abs.length > WEI_DECIMALS ? abs.slice(abs.length - WEI_DECIMALS) : abs)
    .slice(0, maxFrac)
    .replace(/0+$/, '')
  const sign = negative ? '-' : ''
  const compact = (suffix: string, digits: number): string => {
    const keep = whole.length - digits
    return (
      sign +
      (keep > 0 ? whole.slice(0, keep) + '.' + whole.slice(keep, keep + maxFrac) : '0.') +
      suffix
    )
  }
  if (whole.length >= 22) return compact('S', 21)
  if (whole.length >= 19) return compact('T', 18)
  if (whole.length >= 16) return compact('B', 15)
  if (whole.length >= 13) return compact('M', 12)
  if (whole.length >= 10) return compact('K', 9)
  if (whole.length > 0) return sign + groupThousands(whole) + (frac ? '.' + frac : '')
  return sign + '0' + (frac ? '.' + frac : '')
}

/** Raw concentrated-liquidity units (an integer measure, not a token amount). */
export function formatLiquidity(value: string): string {
  const negative = value.startsWith('-')
  const abs = negative ? value.slice(1) : value
  return (negative ? '-' : '') + groupThousands(abs)
}

export function formatLiquidityCompact(value: string): string {
  const negative = value.startsWith('-')
  const abs = negative ? value.slice(1) : value
  const length = abs.length
  if (length > 24)
    return (
      (negative ? '-' : '') +
      abs.slice(0, length - 24) +
      '.' +
      abs.slice(length - 24, length - 22) +
      'S'
    )
  if (length > 21)
    return (
      (negative ? '-' : '') +
      abs.slice(0, length - 21) +
      '.' +
      abs.slice(length - 21, length - 19) +
      'T'
    )
  if (length > 18)
    return (
      (negative ? '-' : '') +
      abs.slice(0, length - 18) +
      '.' +
      abs.slice(length - 18, length - 16) +
      'B'
    )
  if (length > 15)
    return (
      (negative ? '-' : '') +
      abs.slice(0, length - 15) +
      '.' +
      abs.slice(length - 15, length - 13) +
      'M'
    )
  if (length > 12)
    return (
      (negative ? '-' : '') +
      abs.slice(0, length - 12) +
      '.' +
      abs.slice(length - 12, length - 10) +
      'K'
    )
  return (negative ? '-' : '') + groupThousands(abs)
}

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function shortAddress(address: string, chars = 4): string {
  const lower = address.toLowerCase()
  if (!lower.startsWith('0x') || lower.length < chars * 2 + 2) return lower
  return lower.slice(0, 2 + chars) + '…' + lower.slice(-chars)
}

export function txUrl(template: string, hash: string): string {
  return template.replace('{tx}', hash)
}
