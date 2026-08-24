import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PlayConfig } from '../types/content'

vi.mock('../paid/PaidApp', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="paid-app">{embedded ? 'embedded paid app' : 'paid app'}</div>
  ),
}))

vi.mock('../games/pond-guardian/PondGuardianApp', () => ({
  default: ({ onExit }: { onExit: () => void }) => (
    <div data-testid="pond-guardian-app">
      <h3>Pond Guardian</h3>
      <button type="button" onClick={onExit}>
        Back to arcade
      </button>
    </div>
  ),
}))

const { PlaySection } = await import('../components/PlaySection')

const PLAY: PlayConfig = {
  eyebrow: 'Arcade',
  title: 'FRONG Catch',
  lede: 'Catch flies.',
  note: 'Practice is free.',
  practiceTitle: 'Free practice',
  practiceBlurb: 'No wallet.',
  practiceCta: 'Play free practice',
  paidTitle: 'Trophy run',
  paidBlurb: 'One paid run.',
  paidCta: 'Play for a trophy',
}

const MULTI_GAME_PLAY: PlayConfig = {
  ...PLAY,
  title: 'Pond Arcade',
  games: [
    {
      id: 'frong-catch',
      title: 'FRONG Catch',
      description: 'Catch flies.',
      badge: 'Practice + trophy run',
      thumbnailSrc: '/assets/avatar.png',
      status: 'available',
    },
    {
      id: 'pond-guardian',
      title: 'Pond Guardian',
      description: 'Protect the frog.',
      badge: 'Free · local game',
      thumbnailSrc: '/assets/games/pond-guardian/hero-3d-v1.webp',
      status: 'available',
      ctaLabel: 'Play Pond Guardian',
    },
  ],
}

describe('fan-site paid mode boundary', () => {
  it('loads the paid app only after the paid CTA is selected', async () => {
    const user = userEvent.setup()
    render(<PlaySection play={PLAY} />)

    expect(screen.queryByTestId('paid-app')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: PLAY.paidCta }))

    expect(await screen.findByTestId('paid-app')).toHaveTextContent('embedded paid app')
  })

  it('loads Pond Guardian as a separate game and returns to the library', async () => {
    const user = userEvent.setup()
    render(<PlaySection play={MULTI_GAME_PLAY} />)

    await user.click(screen.getByRole('button', { name: 'Play Pond Guardian' }))
    expect(await screen.findByTestId('pond-guardian-app')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back to arcade' }))
    expect(screen.getByRole('button', { name: 'Play Pond Guardian' })).toBeInTheDocument()
  })
})
