import { afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { XEmbedCard } from '../components/XEmbedCard'
import type { XPostRef } from '../types/content'
import { mockTwttr, mockXApi, resetXMocks } from './xMocks'

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
})
