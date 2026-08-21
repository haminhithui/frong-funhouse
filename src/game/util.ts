const BEST_KEY = 'frong-catch-best-score'

/** Cryptographically random run seed, with a fallback for old environments. */
export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return buf[0]
  }
  return (Date.now() ^ 0x9e3779b9) >>> 0
}

/** window.localStorage, or null when storage is unavailable (private mode, jsdom quirks). */
function storage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      return window.localStorage
    }
  } catch {
    // Fall through to null.
  }
  return null
}

export function loadBestScore(): number {
  try {
    const raw = storage()?.getItem(BEST_KEY) ?? null
    const value = raw === null ? 0 : Number.parseInt(raw, 10)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** Persists the best score, never lowering an existing one. */
export function saveBestScore(score: number): void {
  try {
    const store = storage()
    if (!store) return
    const current = Number.parseInt(store.getItem(BEST_KEY) ?? '0', 10)
    if (score > (Number.isFinite(current) ? current : 0)) {
      store.setItem(BEST_KEY, String(score))
    }
  } catch {
    // Storage unavailable — best score is a nicety, never an error.
  }
}

/** Plain X intent link with the player's own verified score — nothing fabricated. */
export function buildShareUrl(score: number, caught: number, tierName: string): string {
  const text = `I caught ${caught}/45 flies and scored ${score}/109 (${tierName}) in FRONG Catch`
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`
}
