const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed'
const WIDGETS_URL = 'https://platform.x.com/widgets.js'

/** Bounded waits: an embed must always settle into content or a fallback. */
export const OEMBED_TIMEOUT_MS = 8_000
export const WIDGET_TIMEOUT_MS = 10_000

let widgetsScript: Promise<void> | null = null

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
}

/**
 * Injects the official X widgets script once, resolving when it is ready.
 * The promise rejects if the script errors or takes longer than timeoutMs,
 * so callers can settle into their fallback instead of waiting forever.
 */
export function loadXWidgetScript(timeoutMs: number = WIDGET_TIMEOUT_MS): Promise<void> {
  if (typeof window === 'undefined' || window.twttr?.widgets) {
    return Promise.resolve()
  }
  if (!widgetsScript) {
    widgetsScript = new Promise<void>((resolve, reject) => {
      const fail = () => {
        widgetsScript = null
        reject(new Error('Failed to load the X widgets script'))
      }
      // A "load" without the widgets API (blocked or neutered script) must
      // invalidate the cache too, so a later retry re-injects a fresh copy.
      const onLoad = () => {
        if (window.twttr?.widgets) {
          resolve()
        } else {
          fail()
        }
      }
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${WIDGETS_URL}"]`)
      if (existing) {
        const ready = (existing as HTMLScriptElement & { readyState?: string }).readyState
        if (ready === 'complete' && window.twttr?.widgets) {
          // An already-loaded script with the widgets API ready.
          resolve()
          return
        }
        if (ready === 'loading') {
          existing.addEventListener('load', onLoad, { once: true })
          existing.addEventListener('error', fail, { once: true })
          return
        }
        // 'loaded'/'complete' without the widgets API (failed or blocked):
        // remove the stale element so a retry can inject a fresh copy.
        existing.remove()
      }
      const script = document.createElement('script')
      script.src = WIDGETS_URL
      script.async = true
      script.charset = 'utf-8'
      script.onload = onLoad
      script.onerror = fail
      document.head.appendChild(script)
    })
  }
  return Promise.race([widgetsScript, timeout(timeoutMs, 'Timed out loading the X widgets script')])
}

/**
 * Fetches the official oEmbed markup for a tweet URL. `omit_script=true` makes X
 * return the blockquote only (no script), and `theme=dark` renders the embed in
 * dark theme to match the site palette. Aborts after timeoutMs; returns null on
 * any failure so the card can show its fallback link.
 */
export async function fetchOEmbed(
  tweetUrl: string,
  timeoutMs: number = OEMBED_TIMEOUT_MS,
): Promise<string | null> {
  const url = new URL(OEMBED_ENDPOINT)
  url.searchParams.set('url', tweetUrl)
  url.searchParams.set('omit_script', 'true')
  url.searchParams.set('theme', 'dark')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await Promise.race([
      fetch(url.toString(), { signal: controller.signal }),
      timeout(timeoutMs, 'Timed out fetching the X post'),
    ])
    if (!res.ok) return null
    const data = (await res.json()) as { html?: string } | null
    return data?.html || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
