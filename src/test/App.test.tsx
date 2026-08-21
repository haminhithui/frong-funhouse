import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, vi } from 'vitest'
import App from '../App'
import { DEMO_SITE_CONFIG } from '../content/site'
import { mockTwttr, mockXApi, mockXApiPending, resetXMocks } from './xMocks'

const renderApp = () => render(<App config={DEMO_SITE_CONFIG} />)

beforeEach(() => {
  mockTwttr()
  mockXApiPending()
})

afterEach(() => {
  resetXMocks()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('renders the hero, all main sections, and the footer', () => {
    renderApp()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Not Wrong. Just FRONG.')
    expect(screen.getByText('Just Early.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'What is FRONG?' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'The pond gallery' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'FRONG Catch' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Wall of Love' })).toBeInTheDocument()
    expect(screen.getByText(/All frogs reserved/)).toBeInTheDocument()
  })

  it('points the skip link at a focusable main landmark', () => {
    renderApp()
    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#main')
    const main = document.getElementById('main')
    expect(main).toHaveAttribute('tabindex', '-1')
  })

  it('shows the gallery as three X embed cards', async () => {
    mockXApi()
    renderApp()
    const gallery = document.getElementById('art')
    expect(gallery).not.toBeNull()
    expect(await within(gallery!).findAllByText('A test post')).toHaveLength(3)
    expect(gallery!.querySelectorAll('.twitter-tweet')).toHaveLength(3)
  })

  it('has no retired sections and no nav links to them', () => {
    renderApp()

    for (const id of ['fm', 'events', 'radar', 'roadmap', 'join']) {
      expect(document.getElementById(id)).toBeNull()
    }

    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    for (const link of within(nav).getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toMatch(/^#(fm|events|radar|roadmap|join)$/)
    }
    expect(screen.queryByRole('link', { name: /fm|events|radar|roadmap|join/i })).toBeNull()
  })

  it('shows the Wall of Love with three X embed cards', async () => {
    mockXApi()
    renderApp()
    const wall = document.getElementById('community')
    expect(wall).not.toBeNull()
    expect(await within(wall!).findAllByText('A test post')).toHaveLength(3)
    expect(wall!.querySelectorAll('.twitter-tweet')).toHaveLength(3)
  })

  it('shows the contract address as a neutral note with a copy action', () => {
    renderApp()
    expect(screen.getByText('0x6245e67affa44a23077f0ea7f981a8dc743a0c47')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByText(/Shown for identification only/)).toBeInTheDocument()
  })

  it('lists the two external discovery links with exact URLs and neutral labels', () => {
    renderApp()

    const pools = screen.getByRole('link', { name: /Explore Pools/ })
    expect(pools).toHaveAttribute(
      'href',
      'https://pools.trade/t/0x6245e67affA44a23077f0Ea7f981a8DC743a0c47',
    )
    expect(pools).toHaveAttribute('target', '_blank')
    expect(pools).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(pools.closest('header')).not.toBeNull()

    const uniswap = screen.getByRole('link', { name: /Open Uniswap/ })
    expect(uniswap).toHaveAttribute('href', 'https://app.uniswap.org/')
    expect(uniswap).toHaveAttribute('target', '_blank')
    expect(uniswap.closest('header')).not.toBeNull()

    // screenshot order: the external links come before the nav links
    const about = screen.getByRole('link', { name: 'About' })
    expect(pools.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(uniswap.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )

    // links now live in the header; the hero keeps only the disclaimer
    expect(screen.queryByText('POND PLUMBING')).toBeNull()
    expect(screen.queryByText(/grown-up plumbing/)).toBeNull()
    expect(
      screen.getByText(
        'External discovery links only. Not sponsorship, endorsement, or financial advice.',
      ),
    ).toBeInTheDocument()
  })

  it('drops the outdated no-links sentence from the chain note', () => {
    renderApp()
    expect(
      screen.queryByText(/does not link to any explorer, exchange, pool, or trading venue/),
    ).toBeNull()
    expect(screen.getByText(/Shown for identification only/)).toBeInTheDocument()
  })

  it('keeps wallet UI behind the trophy-run choice (no wallet prompts on load)', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    renderApp()

    // Nothing wallet-related on load; no buy or investment claims anywhere.
    expect(screen.queryByRole('button', { name: /connect/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /buy frong/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /buy/i })).toBeNull()
    expect(screen.queryByText(/buy frong|trade frong/i)).toBeNull()

    // Choosing the trophy run reveals the wallet flow.
    await user.click(screen.getByRole('button', { name: 'Play for a trophy' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('button', { name: 'Connect injected wallet' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect with WalletConnect' })).toBeInTheDocument()
  })

  it('renders the featured X post card as an official embed', async () => {
    mockXApi()
    renderApp()
    expect(screen.getByRole('heading', { name: 'Featured from X' })).toBeInTheDocument()
    const featured = document.getElementById('featured')
    expect(featured).not.toBeNull()
    expect(await within(featured!).findByText('A test post')).toBeInTheDocument()
    expect(featured!.querySelectorAll('.twitter-tweet')).toHaveLength(1)
  })

  it('embeds the arcade in the fan page with practice and paid modes', async () => {
    const user = userEvent.setup()
    renderApp()

    const play = document.getElementById('play')
    expect(play).not.toBeNull()

    // exactly one game heading: the section title
    const heading = within(play!).getByRole('heading', { name: 'FRONG Catch' })
    expect(heading.tagName).toBe('H2')

    // both modes are offered from the menu
    expect(within(play!).getByRole('button', { name: 'Play free practice' })).toBeInTheDocument()
    expect(within(play!).getByRole('button', { name: 'Play for a trophy' })).toBeInTheDocument()
    expect(
      within(play!).getByText(/Practice mode is free — no wallet, no prizes/),
    ).toBeInTheDocument()

    // the nav points at the in-page section
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).getByRole('link', { name: 'Play' })).toHaveAttribute('href', '#play')

    // no standalone game page shell remains
    expect(screen.queryByRole('link', { name: /Back to the fan page/i })).toBeNull()

    // practice mode renders the game panel, labelled by the section heading
    await user.click(screen.getByRole('button', { name: 'Play free practice' }))
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(document.querySelector('[aria-labelledby="play-title"]')).not.toBeNull()

    // back to the mode menu
    await user.click(screen.getByRole('button', { name: 'Back to arcade modes' }))
    expect(screen.getByRole('button', { name: 'Play for a trophy' })).toBeInTheDocument()
  })

  it('shows the independent fan-media disclaimer', () => {
    renderApp()
    expect(
      screen.getByText(
        /Independent fan-made community media. Not affiliated with or endorsed by the FRONG token team, Robinhood Chain, Pools, or Uniswap. Not financial advice. Verify contracts and links yourself./,
      ),
    ).toBeInTheDocument()
  })
})
