import { afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GallerySection } from '../components/GallerySection'
import { DEMO_SITE_CONFIG } from '../content/site'
import { mockTwttr, mockXApi, resetXMocks } from './xMocks'

afterEach(() => {
  resetXMocks()
})

describe('GallerySection', () => {
  it('renders three embed cards in a grid', async () => {
    mockTwttr()
    mockXApi()
    render(<GallerySection gallery={DEMO_SITE_CONFIG.gallery} />)
    expect(screen.getByRole('heading', { name: 'The pond gallery' })).toBeInTheDocument()
    expect(await screen.findAllByText('A test post')).toHaveLength(3)
    expect(document.querySelectorAll('#art .twitter-tweet')).toHaveLength(3)
  })

  it('renders the X embed as the single frame (no shell or padding)', async () => {
    mockTwttr()
    mockXApi()
    render(<GallerySection gallery={DEMO_SITE_CONFIG.gallery} />)
    await screen.findAllByText('A test post')
    const cards = document.querySelectorAll('#art article')
    expect(cards).toHaveLength(3)
    for (const card of cards) {
      expect(card.className).toContain('cardFlush')
      expect(card.className).toContain('cardBare')
    }
  })
})
