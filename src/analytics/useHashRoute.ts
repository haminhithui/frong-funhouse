import { useEffect, useState } from 'react'

/**
 * Minimal hash router for the standalone analytics screen: the route is active
 * while location.hash starts with '#/analytics'. No history API, no server
 * changes - the built fan site stays statically hostable.
 */
export function useAnalyticsRoute(): boolean {
  const [active, setActive] = useState(() =>
    typeof window !== 'undefined' ? window.location.hash.startsWith('#/analytics') : false,
  )

  useEffect(() => {
    const onHashChange = () => {
      setActive(window.location.hash.startsWith('#/analytics'))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return active
}

/**
 * Saves the home-page scroll position when the analytics route opens and
 * restores it when the route closes (back to home).
 */
export function useAnalyticsScrollRestore(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const saved = window.scrollY
    const scroll = (top: number) => {
      if (typeof window.scrollTo === 'function') window.scrollTo(0, top)
    }
    scroll(0)
    return () => scroll(saved)
  }, [active])
}
