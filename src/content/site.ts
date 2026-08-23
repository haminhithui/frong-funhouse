import type { NavItem, SiteConfig } from '../types/content'
import { ECOSYSTEM_LINKS, ECOSYSTEM_WARNING } from './ecosystem'
import { FEATURED_X_POST, GALLERY_POSTS, X_POSTS } from './x'

/** Demo navigation — replaced when rebranding. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'about', label: 'About', href: '#about' },
  { id: 'art', label: 'Art', href: '#art' },
  { id: 'play', label: 'Play', href: '#play' },
  { id: 'analytics', label: 'Analytics', href: '#/analytics' },
  { id: 'community', label: 'Community', href: '#community' },
]

/**
 * The FRONG demo configuration. All brand copy, navigation, disclaimer, contract
 * note, and verified X records live HERE. The UI components only receive typed
 * props and never import FRONG constants — swap this object to rebrand.
 */
export const DEMO_SITE_CONFIG: SiteConfig = {
  name: 'FRONG',
  header: {
    brandMarkSrc: '/assets/avatar.png',
    navItems: NAV_ITEMS,
    externalLinks: ECOSYSTEM_LINKS,
  },
  hero: {
    eyebrow: 'Independent fan-made community media',
    titlePrefix: 'Not Wrong. Just ',
    titleAccent: 'FRONG',
    titleSuffix: '.',
    titleSecondLine: 'Just Early.',
    support:
      'Original frog art, community culture, and verifiable context — kept small, kept honest, kept on the lily pad.',
    ctaLabel: 'See the community',
    ctaHref: '#community',
    disclaimer: ECOSYSTEM_WARNING,
    artSrc: '/assets/hero-4x.png',
    artAlt: '',
    artSize: 300,
  },
  about: {
    eyebrow: 'About',
    title: 'What is FRONG?',
    lede: 'FRONG is an internet frog: a meme, a mood, and a corner of pond culture. This site is a small, independent fan page for original frog art, community culture, and verifiable context. Nothing here is official, and nothing here is financial advice.',
    chainTitle: 'On-chain reference',
    chainText:
      'If you look FRONG up on-chain, verify the address yourself in a source you trust. The address below is the FRONG token contract recorded for Robinhood Chain in public sources:',
    contractAddress: '0x6245e67affa44a23077f0ea7f981a8dc743a0c47',
    fineText:
      'Shown for identification only. External discovery links appear in the header above — none of them is an endorsement.',
  },
  gallery: {
    eyebrow: 'Gallery',
    title: 'The pond gallery',
    lede: 'Three verified public posts from X, rendered live.',
    posts: GALLERY_POSTS,
  },
  featured: {
    eyebrow: 'X',
    title: 'Featured from X',
    lede: 'Featured public posts, published only after the exact post URL, handle, text, and source have been verified.',
    post: FEATURED_X_POST,
  },
  wall: {
    eyebrow: 'Community',
    title: 'Wall of Love',
    lede: 'Real words from real people on X — nothing staged, nothing invented. Each entry is a verified public post.',
    posts: X_POSTS,
  },
  play: {
    eyebrow: 'Pond Arcade',
    title: 'FRONG Catch',
    lede: "Catch falling flies on FRONG's lily pad — one minute, forty-five flies, 109 points if you catch them all. Practice is free; trophy runs are paid on-chain.",
    note: 'Practice mode is free — no wallet, no prizes, scores stay on this device. Trophy runs cost a non-refundable FRONG entry fee and require a wallet.',
    practiceTitle: 'Free practice',
    practiceBlurb:
      'No wallet, no payment, no prizes. One minute, forty-five flies — just pond pride.',
    practiceCta: 'Play free practice',
    paidTitle: 'Trophy run',
    paidBlurb:
      'Pay a FRONG entry fee, play one replay-verified run, and earn an ERC-721 trophy minted straight to your wallet.',
    paidCta: 'Play for a trophy',
  },
  analytics: {
    eyebrow: 'Pond ledger',
    title: 'Fee & liquidity analytics',
    lede: 'The live FRONG trading fee flow, read from on-chain events on Robinhood Chain mainnet — collected, split, compounded, and grown. Exact where the chain says so; nothing estimated, nothing invented.',
    note: 'Pool facts are verified on-chain: the FRONG/ETH pool charges a static 0.25% LP fee plus a separate 0.04% protocol fee per direction. The compounding threshold (minLiquidityIncrease, 1e20 = 100 FRONG) is a minimum for reinvesting, not a fee percentage.',
  },
  footer: {
    tagline: 'Not Wrong. Just FRONG. Just Early.',
    copyright: 'The Pond. All frogs reserved.',
    disclaimer:
      'Independent fan-made community media. Not affiliated with or endorsed by the FRONG token team, Robinhood Chain, Pools, or Uniswap. Not financial advice. Verify contracts and links yourself.',
    tileSrc: '/assets/avatar.png',
  },
}
