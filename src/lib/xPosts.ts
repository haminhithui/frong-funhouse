const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed'
const WIDGETS_URL = 'https://platform.x.com/widgets.js'

let widgetsScript: Promise<void> | null = null

/** Injects the official X widgets script once, resolving when it is ready. */
export function loadXWidgetScript(): Promise<void> {
  if (typeof window === 'undefined' || window.twttr?.widgets) {
    return Promise.resolve()
  }
  if (widgetsScript) return widgetsScript

  widgetsScript = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${WIDGETS_URL}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener(
        'error',
        () => {
          widgetsScript = null
          reject(new Error('Failed to load the X widgets script'))
        },
        { once: true },
      )
      return
    }

    const script = document.createElement('script')
    script.src = WIDGETS_URL
    script.async = true
    script.charset = 'utf-8'
    script.onload = () => resolve()
    script.onerror = () => {
      widgetsScript = null
      reject(new Error('Failed to load the X widgets script'))
    }
    document.head.appendChild(script)
  })

  return widgetsScript
}

/**
 * Fetches the official oEmbed markup for a tweet URL. `omit_script=true` makes X
 * return the blockquote only (no script), and `theme=dark` renders the embed in
 * dark theme to match the site palette.
 */
export async function fetchOEmbed(tweetUrl: string): Promise<string | null> {
  const url = new URL(OEMBED_ENDPOINT)
  url.searchParams.set('url', tweetUrl)
  url.searchParams.set('omit_script', 'true')
  url.searchParams.set('theme', 'dark')
  try {
    const res = await fetch(url.toString())
    if (!res.ok) return null
    const data = (await res.json()) as { html?: string } | null
    return data?.html || null
  } catch {
    return null
  }
}
