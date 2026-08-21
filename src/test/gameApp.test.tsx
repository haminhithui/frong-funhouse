import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GameApp from '../game/GameApp'
import { loadBestScore, saveBestScore } from '../game/util'

/** A fast run for tests: 1-tick countdown, 60-tick (1s) game. */
const SHORT_RUN = { durationTicks: 60, countdownTicks: 1 }

beforeEach(() => {
  // jsdom has no canvas implementation; keep getContext a quiet no-op.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => null,
  })
  window.localStorage.clear()
})

describe('FRONG Catch game app', () => {
  it('renders the attract screen with rules, fly legend, tiers, and a play button', () => {
    render(<GameApp {...SHORT_RUN} />)
    expect(screen.getByRole('heading', { name: /FRONG Catch/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(screen.getByText(/Move: mouse, touch, or ← → arrow keys/)).toBeInTheDocument()
    // 5 fly legend items + 6 tier rows
    expect(screen.getAllByRole('listitem')).toHaveLength(11)
    expect(screen.getByText('Just FRONG.')).toBeInTheDocument()
    expect(screen.getByText('Not Wrong.')).toBeInTheDocument()
  })

  it('lists all five fly types with their point values', () => {
    render(<GameApp {...SHORT_RUN} />)
    const legend = screen.getByRole('list', { name: 'Fly types and points' })
    expect(within(legend).getByText('Gnat')).toBeInTheDocument()
    expect(within(legend).getByText('Midge')).toBeInTheDocument()
    expect(within(legend).getByText('Drifter')).toBeInTheDocument()
    expect(within(legend).getByText('Golden Firefly')).toBeInTheDocument()
    expect(within(legend).getByText('Queen Fly')).toBeInTheDocument()
    expect(within(legend).getByText('+10')).toBeInTheDocument()
    expect(within(legend).getByText('+1')).toBeInTheDocument()
  })

  it('starts a run on Play and shows the HUD and canvas', async () => {
    const user = userEvent.setup()
    const { container } = render(<GameApp {...SHORT_RUN} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))

    expect(screen.getByText(/Score/)).toBeInTheDocument()
    expect(screen.getByText(/Flies/)).toBeInTheDocument()
    expect(screen.getByText(/Time/)).toBeInTheDocument()
    expect(container.querySelector('canvas')).not.toBeNull()
  })

  it('completes a run and shows results with a share link', async () => {
    const user = userEvent.setup()
    render(<GameApp {...SHORT_RUN} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))

    const playAgain = await screen.findByRole('button', { name: 'Play again' }, { timeout: 8000 })
    expect(playAgain).toBeInTheDocument()
    expect(screen.getByText(/\/109/)).toBeInTheDocument()
    expect(screen.getByText(/\/45/)).toBeInTheDocument()

    const share = screen.getByRole('link', { name: 'Share on X' })
    expect(share).toHaveAttribute(
      'href',
      expect.stringContaining('https://x.com/intent/post?text='),
    )
    expect(share).toHaveAttribute('href', expect.stringContaining('I%20caught'))
  })

  it('starts a fresh run when Play again is clicked', async () => {
    const user = userEvent.setup()
    render(<GameApp {...SHORT_RUN} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await screen.findByRole('button', { name: 'Play again' }, { timeout: 8000 })
    await user.click(screen.getByRole('button', { name: 'Play again' }))

    expect(screen.getByText(/Score/)).toBeInTheDocument()
  })

  it('pauses with the P key, resumes, and quits back to attract', async () => {
    const user = userEvent.setup()
    render(<GameApp {...SHORT_RUN} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByText(/Score/)).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'p' })
    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(screen.queryByText('Paused')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'p' })
    await user.click(screen.getByRole('button', { name: 'Quit' }))
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('exposes a polite live region for announcements', () => {
    render(<GameApp {...SHORT_RUN} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('moves focus to the results heading when a run ends', async () => {
    const user = userEvent.setup()
    render(<GameApp {...SHORT_RUN} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))

    const heading = await screen.findByRole('heading', { name: 'Tadpole' }, { timeout: 8000 })
    expect(heading).toHaveFocus()
  })

  it('moves focus into the run screen when a run starts', async () => {
    const user = userEvent.setup()
    render(<GameApp {...SHORT_RUN} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    // The run stage is a focusable labelled container; focus lands there
    // on run start, before any results exist.
    const stage = await screen.findByLabelText('Game run')
    expect(stage).toHaveFocus()
  })

  it('offers a restart button from the pause overlay', async () => {
    const user = userEvent.setup()
    render(<GameApp {...SHORT_RUN} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.keyDown(window, { key: 'p' })
    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
  })
})

describe('best score storage', () => {
  it('round-trips the best score through localStorage', () => {
    expect(loadBestScore()).toBe(0)
    saveBestScore(88)
    expect(loadBestScore()).toBe(88)
    saveBestScore(40)
    expect(loadBestScore()).toBe(88)
  })

  it('reads a best score that survives a remount', () => {
    saveBestScore(71)
    render(<GameApp {...SHORT_RUN} />)
    expect(screen.getByText(/Your best:/)).toBeInTheDocument()
    expect(screen.getByText('71')).toBeInTheDocument()
  })

  it('ignores corrupt stored values', () => {
    window.localStorage.setItem('frong-catch-best-score', 'not-a-number')
    expect(loadBestScore()).toBe(0)
  })
})

describe('share url builder', () => {
  it('encodes the players own score without fabricating anything', async () => {
    const user = userEvent.setup()
    render(<GameApp {...SHORT_RUN} />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await screen.findByRole('link', { name: 'Share on X' }, { timeout: 8000 })
    const href = screen.getByRole('link', { name: 'Share on X' }).getAttribute('href') ?? ''
    const decoded = decodeURIComponent(href)
    expect(decoded).toContain('https://x.com/intent/post?text=I caught')
    expect(decoded).toContain('/45 flies and scored')
    expect(decoded).toContain('/109 (')
    expect(decoded).toContain('in FRONG Catch')
  })
})
