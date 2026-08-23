import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PlayConfig } from '../types/content'

vi.mock('../paid/PaidApp', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="paid-app">{embedded ? 'embedded paid app' : 'paid app'}</div>
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

describe('fan-site paid mode boundary', () => {
  it('loads the paid app only after the paid CTA is selected', async () => {
    const user = userEvent.setup()
    render(<PlaySection play={PLAY} />)

    expect(screen.queryByTestId('paid-app')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: PLAY.paidCta }))

    expect(await screen.findByTestId('paid-app')).toHaveTextContent('embedded paid app')
  })
})
