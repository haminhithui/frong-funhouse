import { useCallback, useEffect, useState } from 'react'
import { POOL_ID } from './core'

export type EstimatedPairStatus = 'loading' | 'ready' | 'error'

export interface EstimatedPair {
  status: EstimatedPairStatus
  priceUsd: string | null
  volume24hUsd: string | null
  liquidityUsd: string | null
  fetchedAt: number | null
  source: string
}

const SOURCE = 'DexScreener pair API (external, ESTIMATED)'
const EMPTY: EstimatedPair = {
  status: 'loading',
  priceUsd: null,
  volume24hUsd: null,
  liquidityUsd: null,
  fetchedAt: null,
  source: SOURCE,
}

/**
 * Fetches the external DexScreener pair snapshot for the FRONG/ETH pool.
 * Strictly display-only: these values are labeled Estimated, carry a source
 * and fetchedAt, and never feed any exact totals. Static fetch, no polling.
 */
export function useEstimatedPair(): { pair: EstimatedPair; reload: () => void } {
  const [pair, setPair] = useState<EstimatedPair>(EMPTY)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    async function load(): Promise<void> {
      setPair((previous) => ({ ...previous, status: 'loading' }))
      try {
        const res = await fetch(
          'https://api.dexscreener.com/latest/dex/pairs/robinhood/' + POOL_ID,
          { signal: controller.signal },
        )
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const json = (await res.json()) as { pairs?: Array<Record<string, unknown>> }
        const first = json.pairs?.[0]
        if (!first || typeof first.priceUsd !== 'string') {
          throw new Error('pair not found in feed')
        }
        const volume = first.volume as { h24?: number } | undefined
        const liquidity = first.liquidity as { usd?: number } | undefined
        if (cancelled) return
        setPair({
          status: 'ready',
          priceUsd: first.priceUsd,
          volume24hUsd: typeof volume?.h24 === 'number' ? String(volume.h24) : null,
          liquidityUsd: typeof liquidity?.usd === 'number' ? String(liquidity.usd) : null,
          fetchedAt: Math.floor(Date.now() / 1000),
          source: SOURCE,
        })
      } catch (error) {
        if (cancelled) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setPair((previous) => ({ ...previous, status: 'error' }))
      }
    }
    void load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [attempt])

  const reload = useCallback(() => {
    setAttempt((value) => value + 1)
  }, [])

  return { pair, reload }
}
