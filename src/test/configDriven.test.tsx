import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'
import App from '../App'
import { DEMO_SITE_CONFIG } from '../content/site'
import type { SiteConfig } from '../types/content'
import { mockTwttr, mockXApi, mockXApiPending, resetXMocks } from './xMocks'

const CUSTOM_CONFIG: SiteConfig = {
  name: 'PONDVERSE',
  header: {
    brandMarkSrc: '/custom-mark.png',
    navItems: [
      { id: 'lore', label: 'Lore', href: '#lore' },
      { id: 'artwork', label: 'Artwork', href: '#artwork' },
    ],
    externalLinks: [
      { id: 'docs', label: 'Docs', url: 'https://docs.example.com/', description: 'Docs' },
      { id: 'social', label: 'Socials', url: 'https://example.com/social', description: 'Socials' },
    ],
  },
  hero: {
    eyebrow: 'Custom eyebrow',
    titlePrefix: 'A ',
    titleAccent: 'TEST',
    titleSuffix: ' site',
    titleSecondLine: 'Second line.',
    support: 'Custom support copy.',
    ctaLabel: 'Custom CTA',
    ctaHref: '#custom-target',
    disclaimer: 'Custom disclaimer.',
    artSrc: '/custom-art.png',
    artAlt: '',
    artSize: 200,
  },
  about: {
    eyebrow: 'About C',
    title: 'About custom site',
    lede: 'Custom lede.',
    chainTitle: 'Custom chain',
    chainText: 'Custom chain text.',
    contractAddress: '0xabc123',
    fineText: 'Custom fine print.',
  },
  gallery: {
    eyebrow: 'Gallery C',
    title: 'Custom gallery',
    lede: 'Custom gallery lede.',
    posts: [{ id: '1', url: 'https://x.com/custom/status/1' }],
  },
  featured: {
    eyebrow: 'X C',
    title: 'Custom featured',
    lede: 'Custom featured lede.',
    post: { id: '2', url: 'https://x.com/custom/status/2' },
  },
  wall: {
    eyebrow: 'Wall C',
    title: 'Custom wall',
    lede: 'Custom wall lede.',
    posts: [{ id: '3', url: 'https://x.com/custom/status/3' }],
  },
  footer: {
    tagline: 'Custom tagline.',
    copyright: 'Custom copyright.',
    disclaimer: 'Custom footer disclaimer.',
    tileSrc: '/custom-tile.png',
  },
}

beforeEach(() => {
  mockTwttr()
  mockXApiPending()
})

afterEach(() => {
  resetXMocks()
})

describe('config-driven UI', () => {
  it('renders a fully custom site from config with no FRONG copy leaking', () => {
    render(<App config={CUSTOM_CONFIG} />)

    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('A TEST site')
    expect(screen.getByText('Second line.')).toBeInTheDocument()
    expect(screen.getByText('Custom support copy.')).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'About custom site' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Custom gallery' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Custom featured' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Custom wall' })).toBeInTheDocument()
    expect(screen.getByText('Custom footer disclaimer.')).toBeInTheDocument()

    // no hard-coded FRONG brand copy anywhere
    expect(screen.queryByText(/FRONG/i)).toBeNull()
  })

  it('drives header brand, nav, and external links entirely from config', () => {
    render(<App config={CUSTOM_CONFIG} />)

    const brand = screen.getByRole('link', { name: 'PONDVERSE home' })
    expect(brand).toHaveAttribute('href', '#top')

    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    const navLinks = within(nav).getAllByRole('link')
    expect(navLinks.map((link) => link.textContent)).toEqual(['Lore', 'Artwork'])
    expect(navLinks.map((link) => link.getAttribute('href'))).toEqual(['#lore', '#artwork'])

    const docs = screen.getByRole('link', { name: 'Docs' })
    expect(docs).toHaveAttribute('href', 'https://docs.example.com/')
    expect(docs).toHaveAttribute('target', '_blank')
    expect(docs).toHaveAttribute('rel', expect.stringContaining('noopener'))

    const social = screen.getByRole('link', { name: 'Socials' })
    expect(social).toHaveAttribute('href', 'https://example.com/social')

    // external links come before nav links, in config order
    expect(docs.compareDocumentPosition(navLinks[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(social.compareDocumentPosition(navLinks[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('wires the hero CTA and disclaimer from config', () => {
    render(<App config={CUSTOM_CONFIG} />)

    const cta = screen.getByRole('link', { name: 'Custom CTA' })
    expect(cta).toHaveAttribute('href', '#custom-target')
    expect(screen.getByText('Custom disclaimer.')).toBeInTheDocument()
  })

  it('wires the contract note and copy action from config', () => {
    render(<App config={CUSTOM_CONFIG} />)

    expect(screen.getByRole('heading', { name: 'Custom chain' })).toBeInTheDocument()
    expect(screen.getByText('0xabc123')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByText('Custom fine print.')).toBeInTheDocument()
  })

  it('renders the configured post sets as embed cards', async () => {
    mockXApi()
    render(<App config={CUSTOM_CONFIG} />)

    const art = document.getElementById('art')
    const featured = document.getElementById('featured')
    const community = document.getElementById('community')
    expect(art).not.toBeNull()
    expect(featured).not.toBeNull()
    expect(community).not.toBeNull()

    expect(await within(art!).findAllByText('A test post')).toHaveLength(1)
    expect(await within(featured!).findAllByText('A test post')).toHaveLength(1)
    expect(await within(community!).findAllByText('A test post')).toHaveLength(1)
  })

  it('renders the demo FRONG brand only through the demo config', () => {
    render(<App config={DEMO_SITE_CONFIG} />)

    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('Not Wrong. Just FRONG.')
    expect(within(h1).getByText('FRONG')).toBeInTheDocument()
  })
})
