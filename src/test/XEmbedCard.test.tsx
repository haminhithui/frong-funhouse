import { afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { XEmbedCard } from '../components/XEmbedCard'
import type { XPostRef } from '../types/content'
import { mockTwttr, mockXApi, mockXApiPending, resetXMocks, TEST_OEMBED_HTML } from './xMocks'

const POST: XPostRef = {
  id: '2088370565644259531',
  url: 'https://x.com/TradePools/status/2088370565644259531',
}

afterEach(() => {
  resetXMocks()
})

describe('XEmbedCard', () => {
  it('renders the official embed', async () => {
    mockTwttr()
    mockXApi()
    render(<XEmbedCard post={POST} />)
    expect(await screen.findByText('A test post')).toBeInTheDocument()
  })

  it('forces the dark theme on the injected blockquote', async () => {
    mockTwttr()
    mockXApi()
    render(<XEmbedCard post={POST} />)
    await screen.findByText('A test post')
    const blockquote = document.querySelector('blockquote.twitter-tweet')
    expect(blockquote).not.toBeNull()
    expect(blockquote!.getAttribute('data-theme')).toBe('dark')
  })

  it('re-renders the embed when the window resizes', async () => {
    const { load } = mockTwttr()
    mockXApi()
    render(<XEmbedCard post={POST} />)
    await screen.findByText('A test post')
    const before = load.mock.calls.length
    expect(before).toBeGreaterThan(0)

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(before), {
      timeout: 1500,
    })
  })

  it('falls back to a plain link when oEmbed fails', async () => {
    mockTwttr()
    mockXApi({ oEmbedHtml: null })
    render(<XEmbedCard post={POST} />)
    const link = await screen.findByRole('link', { name: /View this post on X/ })
    expect(link).toHaveAttribute('href', POST.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('retries the oEmbed fetch from the fallback state', async () => {
    mockTwttr()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) return new Response('', { status: 404 })
        return new Response(JSON.stringify({ html: TEST_OEMBED_HTML }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    render(<XEmbedCard post={POST} />)
    expect(await screen.findByRole('link', { name: /View this post on X/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('A test post')).toBeInTheDocument()
    expect(calls).toBe(2)
  })

  it('falls back to a plain link when the oEmbed fetch times out', async () => {
    vi.useFakeTimers()
    try {
      mockTwttr()
      mockXApiPending()
      render(<XEmbedCard post={POST} />)
      expect(screen.getByText('Loading post…')).toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(9_000)
      })

      const link = screen.getByRole('link', { name: /View this post on X/ })
      expect(link).toHaveAttribute('href', POST.url)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a View on X link when the widgets script never loads', async () => {
    vi.useFakeTimers()
    try {
      mockXApi() // oEmbed resolves; window.twttr stays undefined so the script never loads
      render(<XEmbedCard post={POST} />)

      await act(async () => {})
      expect(screen.getByText('A test post')).toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(11_000)
      })

      expect(screen.getByRole('link', { name: /View on X/ })).toHaveAttribute('href', POST.url)
      // The official blockquote fallback stays in place alongside the link.
      expect(document.querySelector('blockquote.twitter-tweet')).not.toBeNull()

      // Retrying re-runs the widget load; with the script still missing it
      // settles back into the same degraded state without losing content.
      fireEvent.click(screen.getByRole('button', { name: 'Retry embed' }))
      expect(screen.queryByRole('link', { name: /View on X/ })).not.toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(11_000)
      })
      expect(screen.getByRole('link', { name: /View on X/ })).toHaveAttribute('href', POST.url)
      expect(document.querySelector('blockquote.twitter-tweet')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fetch until the card nears the viewport (lazy loading)', async () => {
    let callback: IntersectionObserverCallback | null = null
    class FakeIntersectionObserver {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    mockTwttr()
    const fetchMock = mockXApi()
    render(<XEmbedCard post={POST} />)

    await act(async () => {})
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText('Loading post…')).toBeInTheDocument()

    await act(async () => {
      callback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })

    expect(await screen.findByText('A test post')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
