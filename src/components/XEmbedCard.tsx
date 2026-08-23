import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchOEmbed, loadXWidgetScript, sanitizeOEmbedHtml } from '../lib/xPosts'
import type { XPostRef } from '../types/content'
import styles from './XEmbedCard.module.css'

interface XEmbedProps {
  html: string
  /** Called when the official widget cannot upgrade the blockquote (script
      failed or timed out) — the card adds a visible "View on X" link. */
  onDegraded: () => void
  /** Bumped by the retry action to re-run the widget load. */
  attempt: number
}

function XEmbed({ html, onDegraded, attempt }: XEmbedProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !html) return
    let cancelled = false
    let resizeTimer: number | undefined
    let lastWidth = el.clientWidth

    const render = () => {
      if (cancelled) return
      el.replaceChildren(sanitizeOEmbedHtml(html))
      const blockquote = el.querySelector<HTMLElement>('blockquote.twitter-tweet')
      blockquote?.setAttribute('data-theme', 'dark')
      loadXWidgetScript()
        .then(() => {
          if (cancelled) return
          if (window.twttr?.widgets) {
            window.twttr.widgets.load(el)
          } else {
            // The script "loaded" without exposing the widgets API (blocked
            // or neutered) — treat it as degraded, same as a failed load.
            onDegraded()
          }
        })
        .catch(() => {
          if (!cancelled) onDegraded()
        })
    }

    render()

    // The official widget re-measures on window resize and can mis-size or
    // mis-theme its iframe. Re-render from the blockquote (debounced) so the
    // embed always lands at the capped wrapper width with the dark theme.
    // Only re-render when the wrapper WIDTH actually changed: height-only
    // resizes (mobile browser chrome) must not wipe live iframes.
    const onResize = () => {
      const width = el.clientWidth
      if (width > 0 && lastWidth > 0 && Math.abs(width - lastWidth) <= 1) return
      lastWidth = width
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(render, 250)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelled = true
      window.clearTimeout(resizeTimer)
      window.removeEventListener('resize', onResize)
      el.replaceChildren()
    }
  }, [html, onDegraded, attempt])

  return <div ref={ref} className={styles.embed} />
}

interface XEmbedCardProps {
  post: XPostRef
  /** Flush mode: no inner padding, so the embed fills the card frame edge-to-edge. */
  flush?: boolean
  /** Bare mode: flush and shell-less — the X embed is the single visible frame. */
  bare?: boolean
}

export function XEmbedCard({ post, flush = false, bare = false }: XEmbedCardProps) {
  const [embedHtml, setEmbedHtml] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [degraded, setDegraded] = useState(false)
  const [started, setStarted] = useState(false)
  /** oEmbed fetch attempts — bumped by "Try again" after a failed fetch. */
  const [attempt, setAttempt] = useState(0)
  /** Widget load attempts — bumped by "Retry embed" after a degraded embed. */
  const [widgetAttempt, setWidgetAttempt] = useState(0)
  const cardRef = useRef<HTMLElement | null>(null)

  const handleDegraded = useCallback(() => setDegraded(true), [])

  const retryFetch = useCallback(() => {
    setFailed(false)
    setEmbedHtml(null)
    setAttempt((n) => n + 1)
  }, [])

  const retryWidget = useCallback(() => {
    setDegraded(false)
    setWidgetAttempt((n) => n + 1)
  }, [])

  // Lazy: only start loading when the card nears the viewport, so below-fold
  // sections never compete with the initial page load. Without
  // IntersectionObserver (tests, very old browsers) load immediately.
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setStarted(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setStarted(true)
          observer.disconnect()
        }
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!started) return
    let cancelled = false
    setEmbedHtml(null)
    setFailed(false)
    setDegraded(false)

    void (async () => {
      const html = await fetchOEmbed(post.url)
      if (cancelled) return
      setEmbedHtml(html)
      if (html === null) setFailed(true)
    })()

    return () => {
      cancelled = true
    }
  }, [post.url, started, attempt])

  const classes = [styles.card, flush || bare ? styles.cardFlush : '', bare ? styles.cardBare : '']
    .filter(Boolean)
    .join(' ')

  return (
    <article ref={cardRef} className={classes} aria-busy={!failed && embedHtml === null}>
      {failed ? (
        <div className={styles.fallback}>
          <a
            className={styles.fallbackLink}
            href={post.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            View this post on X <span aria-hidden="true">↗</span>
          </a>
          <button type="button" className={styles.retryButton} onClick={retryFetch}>
            Try again
          </button>
        </div>
      ) : embedHtml ? (
        <>
          <XEmbed html={embedHtml} onDegraded={handleDegraded} attempt={widgetAttempt} />
          {degraded && (
            <div className={styles.fallback}>
              <a
                className={styles.fallbackLink}
                href={post.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                View on X <span aria-hidden="true">↗</span>
              </a>
              <button type="button" className={styles.retryButton} onClick={retryWidget}>
                Retry embed
              </button>
            </div>
          )}
        </>
      ) : (
        <div className={styles.skeleton}>Loading post…</div>
      )}
    </article>
  )
}
