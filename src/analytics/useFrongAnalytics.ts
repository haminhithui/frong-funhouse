import { useCallback, useEffect, useState } from 'react'
import { FRONG_ADDRESS } from './core'
import type { FrongAnalyticsArtifact } from './types'

export type AnalyticsStatus = 'loading' | 'ready' | 'stale' | 'error' | 'empty'

/** Data older than this (seconds) is flagged as stale in the UI. */
export const STALE_AFTER_SECONDS = 24 * 60 * 60

export interface AnalyticsState {
  status: AnalyticsStatus
  artifact: FrongAnalyticsArtifact | null
  error: string | null
  reload: () => void
}

/**
 * Loads the persisted analytics artifact (public/data/frong-analytics.json,
 * produced by scripts/frong-analytics.mjs). Static fetch only - no polling,
 * no websocket, no writes.
 */
export function useFrongAnalytics(): AnalyticsState {
  const [status, setStatus] = useState<AnalyticsStatus>('loading')
  const [artifact, setArtifact] = useState<FrongAnalyticsArtifact | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    async function load(): Promise<void> {
      setStatus('loading')
      setError(null)
      try {
        const res = await fetch('/data/frong-analytics.json', {
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!res.ok) throw new Error('analytics data unavailable (HTTP ' + res.status + ')')
        const json = (await res.json()) as FrongAnalyticsArtifact
        if (json.schemaVersion !== 1 && json.schemaVersion !== 2) {
          throw new Error('analytics artifact schema is not supported')
        }
        const token = json.scope?.token?.address ?? ''
        if (token.toLowerCase() !== FRONG_ADDRESS.toLowerCase()) {
          throw new Error('analytics artifact is scoped to an unexpected token')
        }
        if (cancelled) return
        setArtifact(json)
        const ageSeconds = Date.now() / 1000 - (json.asOf?.timestamp ?? 0)
        const isEmpty =
          (json.totals?.claims ?? 0) === 0 &&
          Object.values(json.events ?? {}).every((list) => list.length === 0)
        setStatus(isEmpty ? 'empty' : ageSeconds > STALE_AFTER_SECONDS ? 'stale' : 'ready')
      } catch (err) {
        if (cancelled) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to load analytics data')
        setStatus('error')
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

  return { status, artifact, error, reload }
}
