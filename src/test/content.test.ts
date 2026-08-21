import { ECOSYSTEM_LINKS, ECOSYSTEM_WARNING } from '../content/ecosystem'
import { DEMO_SITE_CONFIG, NAV_ITEMS } from '../content/site'
import { FEATURED_X_POST, GALLERY_POSTS, X_POST_IDS, X_POST_URLS, X_POSTS } from '../content/x'

describe('X post content model (URL-only)', () => {
  it('ships exactly the three verified public posts', () => {
    expect(X_POSTS).toHaveLength(3)
    expect(X_POST_IDS).toHaveLength(3)
    expect(X_POST_URLS).toHaveLength(3)
  })

  it('keeps ids and urls paired in order', () => {
    expect(X_POSTS).toEqual([
      { id: '2088370565644259531', url: 'https://x.com/TradePools/status/2088370565644259531' },
      { id: '2088371383562850665', url: 'https://x.com/saintniko/status/2088371383562850665' },
      { id: '2088370792132133293', url: 'https://x.com/ianheinischmma/status/2088370792132133293' },
    ])
    expect(X_POST_IDS).toEqual(X_POSTS.map((post) => post.id))
    expect(X_POST_URLS).toEqual(X_POSTS.map((post) => post.url))
  })

  it('keeps every post URL in the canonical x.com status form', () => {
    for (const url of X_POST_URLS) {
      expect(url).toMatch(/^https:\/\/x\.com\/[^/]+\/status\/\d+$/)
    }
  })

  it('features the TradePools post', () => {
    expect(FEATURED_X_POST).toEqual(X_POSTS[0])
  })

  it('carries no hard-coded engagement, identity, or media fields', () => {
    for (const post of X_POSTS) {
      expect(Object.keys(post)).toEqual(['id', 'url'])
      expect(post).not.toHaveProperty('views')
      expect(post).not.toHaveProperty('likes')
      expect(post).not.toHaveProperty('bookmarks')
      expect(post).not.toHaveProperty('reposts')
      expect(post).not.toHaveProperty('replies')
      expect(post).not.toHaveProperty('favorite_count')
      expect(post).not.toHaveProperty('conversation_count')
      expect(post).not.toHaveProperty('name')
      expect(post).not.toHaveProperty('handle')
      expect(post).not.toHaveProperty('text')
      expect(post).not.toHaveProperty('mediaUrl')
      expect(post).not.toHaveProperty('avatarUrl')
      expect(post).not.toHaveProperty('publishedAt')
    }
  })
})

describe('Gallery X posts (URL-only)', () => {
  it('ships exactly the three verified FRONG-live posts', () => {
    expect(GALLERY_POSTS).toHaveLength(3)
    expect(GALLERY_POSTS).toEqual([
      { id: '2088518209813029016', url: 'https://x.com/frongcommunity/status/2088518209813029016' },
      { id: '2087638804718829952', url: 'https://x.com/frongcommunity/status/2087638804718829952' },
      { id: '2087931863234904155', url: 'https://x.com/frongcommunity/status/2087931863234904155' },
    ])
  })

  it('keeps gallery posts URL-only (no mock fields)', () => {
    for (const post of GALLERY_POSTS) {
      expect(Object.keys(post)).toEqual(['id', 'url'])
    }
  })
})

describe('content model', () => {
  it('points no navigation at retired sections', () => {
    const hrefs = NAV_ITEMS.map((item) => item.href)
    expect(hrefs).not.toContain('#fm')
    expect(hrefs).not.toContain('#events')
    expect(hrefs).not.toContain('#radar')
    expect(hrefs).not.toContain('#roadmap')
    expect(hrefs).not.toContain('#join')
  })

  it('orders navigation to match page section order', () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual(['#about', '#art', '#play', '#community'])
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(['About', 'Art', 'Play', 'Community'])
  })

  it('ships exactly the two verified external discovery URLs', () => {
    const urls = ECOSYSTEM_LINKS.map((link) => link.url)
    expect(urls).toEqual([
      'https://pools.trade/t/0x6245e67affA44a23077f0Ea7f981a8DC743a0c47',
      'https://app.uniswap.org/',
    ])
  })

  it('keeps the external-links warning neutral', () => {
    expect(ECOSYSTEM_WARNING).toBe(
      'External discovery links only. Not sponsorship, endorsement, or financial advice.',
    )
    for (const link of ECOSYSTEM_LINKS) {
      expect(link.label).not.toMatch(/buy|trade|official|supported|powered|guaranteed/i)
      expect(link.description).not.toMatch(/guaranteed/i)
    }
  })
})

describe('demo site config (provenance guard)', () => {
  it('is branded FRONG and composes the hero headline from its parts', () => {
    expect(DEMO_SITE_CONFIG.name).toBe('FRONG')
    expect(DEMO_SITE_CONFIG.hero.titlePrefix).toBe('Not Wrong. Just ')
    expect(DEMO_SITE_CONFIG.hero.titleAccent).toBe('FRONG')
    expect(DEMO_SITE_CONFIG.hero.titleSuffix).toBe('.')
    expect(DEMO_SITE_CONFIG.hero.titleSecondLine).toBe('Just Early.')
  })

  it('keeps the exact verified Pools URL as the first header link', () => {
    expect(DEMO_SITE_CONFIG.header.externalLinks[0].url).toBe(
      'https://pools.trade/t/0x6245e67affA44a23077f0Ea7f981a8DC743a0c47',
    )
  })

  it('references the verified post sets (no URLs inlined into the config)', () => {
    expect(DEMO_SITE_CONFIG.gallery.posts).toEqual(GALLERY_POSTS)
    expect(DEMO_SITE_CONFIG.featured.post).toEqual(FEATURED_X_POST)
    expect(DEMO_SITE_CONFIG.wall.posts).toEqual(X_POSTS)
  })

  it('ships the arcade section with practice and paid mode copy', () => {
    expect(DEMO_SITE_CONFIG.play?.title).toBe('FRONG Catch')
    expect(DEMO_SITE_CONFIG.play?.eyebrow).toBe('Pond Arcade')
    expect(DEMO_SITE_CONFIG.play?.note).toMatch(/no wallet, no prizes/i)
    expect(DEMO_SITE_CONFIG.play?.practiceCta).toBe('Play free practice')
    expect(DEMO_SITE_CONFIG.play?.paidCta).toBe('Play for a trophy')
    expect(DEMO_SITE_CONFIG.play?.paidBlurb).toMatch(/FRONG entry fee/i)
    expect(DEMO_SITE_CONFIG.play?.note).toMatch(/non-refundable FRONG entry fee/i)
  })

  it('keeps the lowercase-normalized contract address for identification', () => {
    expect(DEMO_SITE_CONFIG.about.contractAddress).toBe(
      '0x6245e67affa44a23077f0ea7f981a8dc743a0c47',
    )
  })

  it('keeps the independent fan-media disclaimer in the footer', () => {
    expect(DEMO_SITE_CONFIG.footer.disclaimer).toMatch(/Independent fan-made community media/)
    expect(DEMO_SITE_CONFIG.footer.disclaimer).toMatch(/Not financial advice/)
  })
})
