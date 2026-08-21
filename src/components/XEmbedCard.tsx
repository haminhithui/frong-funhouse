import { useEffect, useRef, useState } from 'react'
import { fetchOEmbed, loadXWidgetScript } from '../lib/xPosts'
import type { XPostRef } from '../types/content'
import styles from './XEmbedCard.module.css'

interface XEmbedProps {
  html: string
}

function XEmbed({ html }: XEmbedProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !html) return
    let cancelled = false
    let resizeTimer: number | undefined

    const render = () => {
      if (cancelled) return
      el.innerHTML = html
      const blockquote = el.querySelector<HTMLElement>('blockquote.twitter-tweet')
      blockquote?.setAttribute('data-theme', 'dark')
      loadXWidgetScript()
        .then(() => {
          if (!cancelled) window.twttr?.widgets?.load(el)
        })
        .catch(() => {
          // The oEmbed blockquote stays as fallback content if the widget fails.
        })
    }

    render()

    // The official widget re-measures on window resize and can mis-size or
    // mis-theme its iframe. Re-render from the blockquote (debounced) so the
    // embed always lands at the capped wrapper width with the dark theme.
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(render, 250)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelled = true
      window.clearTimeout(resizeTimer)
      window.removeEventListener('resize', onResize)
      el.innerHTML = ''
    }
  }, [html])

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

  useEffect(() => {
    let cancelled = false
    setEmbedHtml(null)
    setFailed(false)

    void (async () => {
      const html = await fetchOEmbed(post.url)
      if (cancelled) return
      setEmbedHtml(html)
      if (html === null) setFailed(true)
    })()

    return () => {
      cancelled = true
    }
  }, [post.url])

  const classes = [styles.card, flush || bare ? styles.cardFlush : '', bare ? styles.cardBare : '']
    .filter(Boolean)
    .join(' ')

  return (
    <article className={classes}>
      {failed ? (
        <a
          className={styles.fallbackLink}
          href={post.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          View this post on X <span aria-hidden="true">↗</span>
        </a>
      ) : embedHtml ? (
        <XEmbed html={embedHtml} />
      ) : (
        <div className={styles.skeleton}>Loading post…</div>
      )}
    </article>
  )
}
