import { afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WallOfLove } from '../components/WallOfLove'
import { DEMO_SITE_CONFIG } from '../content/site'
import { mockTwttr, mockXApi, resetXMocks } from './xMocks'

afterEach(() => {
  resetXMocks()
})

describe('WallOfLove', () => {
  it('renders three embed cards in a grid', async () => {
    mockTwttr()
    mockXApi()
    render(<WallOfLove wall={DEMO_SITE_CONFIG.wall} />)
    expect(screen.getByRole('heading', { name: 'Wall of Love' })).toBeInTheDocument()
    expect(await screen.findAllByText('A test post')).toHaveLength(3)
    expect(document.querySelectorAll('#community .twitter-tweet')).toHaveLength(3)
  })

  it('renders the X embed as the single frame (no shell or padding)', async () => {
    mockTwttr()
    mockXApi()
    render(<WallOfLove wall={DEMO_SITE_CONFIG.wall} />)
    await screen.findAllByText('A test post')
    const cards = document.querySelectorAll('#community article')
    expect(cards).toHaveLength(3)
    for (const card of cards) {
      expect(card.className).toContain('cardFlush')
      expect(card.className).toContain('cardBare')
    }
  })
})
