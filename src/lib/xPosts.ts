const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed'
const WIDGETS_URL = 'https://platform.x.com/widgets.js'

const EMBED_ELEMENTS = new Set([
  'blockquote',
  'p',
  'a',
  'br',
  'span',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'time',
])
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'])

/**
 * Turns the official oEmbed response into a DOM fragment without executing
 * arbitrary markup returned by a remote endpoint. The widget library only
 * needs the blockquote and its text/link content; scripts, styles, event
 * handlers and foreign URLs are deliberately discarded.
 */
export function sanitizeOEmbedHtml(html: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const blockquote = parsed.querySelector('blockquote.twitter-tweet')
  if (!blockquote) return fragment

  const append = (parent: Node, source: Node): void => {
    if (source.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(source.textContent ?? ''))
      return
    }
    if (!(source instanceof Element)) return
    const tag = source.tagName.toLowerCase()
    if (!EMBED_ELEMENTS.has(tag)) {
      for (const child of Array.from(source.childNodes)) append(parent, child)
      return
    }
    const safe = document.createElement(tag)
    if (tag === 'blockquote') {
      safe.className = 'twitter-tweet'
      const dnt = source.getAttribute('data-dnt')
      if (dnt === 'true') safe.setAttribute('data-dnt', 'true')
    } else if (tag === 'a') {
      const href = source.getAttribute('href')
      try {
        const url = href ? new URL(href, window.location.origin) : null
        if (!url || url.protocol !== 'https:' || !X_HOSTS.has(url.hostname.toLowerCase())) {
          for (const child of Array.from(source.childNodes)) append(parent, child)
          return
        }
        safe.setAttribute('href', url.href)
        safe.setAttribute('target', '_blank')
        safe.setAttribute('rel', 'noreferrer noopener')
      } catch {
        for (const child of Array.from(source.childNodes)) append(parent, child)
        return
      }
    } else {
      for (const attribute of ['lang', 'dir']) {
        const value = source.getAttribute(attribute)
        if (value) safe.setAttribute(attribute, value.slice(0, 32))
      }
    }
    for (const child of Array.from(source.childNodes)) append(safe, child)
    parent.appendChild(safe)
  }

  append(fragment, blockquote)
  return fragment
}

/** Bounded waits: an embed must always settle into content or a fallback. */
export const OEMBED_TIMEOUT_MS = 8_000
export const WIDGET_TIMEOUT_MS = 10_000

let widgetsScript: Promise<void> | null = null

function invalidateWidgetScript(promise: Promise<void>): void {
  if (widgetsScript !== promise) return
  widgetsScript = null
  document.querySelector<HTMLScriptElement>(`script[src="${WIDGETS_URL}"]`)?.remove()
}

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
    let resolveScript!: () => void
    let rejectScript!: (error: Error) => void
    const scriptPromise = new Promise<void>((resolve, reject) => {
      resolveScript = resolve
      rejectScript = reject
    })
    widgetsScript = scriptPromise

    const fail = () => {
      rejectScript(new Error('Failed to load the X widgets script'))
    }
    const onLoad = () => {
      if (window.twttr?.widgets) {
        resolveScript()
      } else {
        fail()
      }
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${WIDGETS_URL}"]`)
    let shouldInject = true
    if (existing) {
      const ready = (existing as HTMLScriptElement & { readyState?: string }).readyState
      if (ready === 'complete' && window.twttr?.widgets) {
        resolveScript()
        shouldInject = false
      } else if (ready === 'loading') {
        existing.addEventListener('load', onLoad, { once: true })
        existing.addEventListener('error', fail, { once: true })
        shouldInject = false
      } else {
        // 'loaded'/'complete' without the widgets API (failed or blocked):
        // remove the stale element so a retry can inject a fresh copy.
        existing.remove()
      }
    }
    if (shouldInject) {
      const script = document.createElement('script')
      script.src = WIDGETS_URL
      script.async = true
      script.charset = 'utf-8'
      script.onload = onLoad
      script.onerror = fail
      document.head.appendChild(script)
    }
  }
  const current = widgetsScript
  if (!current) return Promise.reject(new Error('X widgets script could not be initialized'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      invalidateWidgetScript(current)
      reject(new Error('Timed out loading the X widgets script'))
    }, timeoutMs)
    current.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        invalidateWidgetScript(current)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
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
  let postUrl: URL
  try {
    postUrl = new URL(tweetUrl)
  } catch {
    return null
  }
  if (postUrl.protocol !== 'https:' || !X_HOSTS.has(postUrl.hostname.toLowerCase())) {
    return null
  }
  const url = new URL(OEMBED_ENDPOINT)
  url.searchParams.set('url', postUrl.href)
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
