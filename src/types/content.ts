export interface NavItem {
  id: string
  label: string
  href: string
}

export interface EcosystemLink {
  id: string
  label: string
  url: string
  description: string
}

/** A verified public X post reference — URL-only; nothing is rehosted or staged. */
export interface XPostRef {
  id: string
  url: string
}

export interface HeaderConfig {
  brandMarkSrc: string
  navItems: readonly NavItem[]
  externalLinks: readonly EcosystemLink[]
}

export interface HeroConfig {
  eyebrow: string
  titlePrefix: string
  titleAccent: string
  titleSuffix: string
  titleSecondLine: string
  support: string
  ctaLabel: string
  ctaHref: string
  disclaimer: string
  artSrc: string
  artAlt: string
  artSize: number
}

export interface AboutConfig {
  eyebrow: string
  title: string
  lede: string
  chainTitle: string
  chainText: string
  contractAddress: string
  fineText: string
}

export interface GalleryConfig {
  eyebrow: string
  title: string
  lede: string
  posts: readonly XPostRef[]
}

export interface FeaturedConfig {
  eyebrow: string
  title: string
  lede: string
  post: XPostRef
}

export interface WallConfig {
  eyebrow: string
  title: string
  lede: string
  posts: readonly XPostRef[]
}

export interface PlayConfig {
  eyebrow: string
  title: string
  lede: string
  note: string
  practiceTitle: string
  practiceBlurb: string
  practiceCta: string
  paidTitle: string
  paidBlurb: string
  paidCta: string
}

/** Read-only fee/liquidity analytics section copy. */
export interface AnalyticsConfig {
  eyebrow: string
  title: string
  lede: string
  note: string
}

export interface FooterConfig {
  tagline: string
  copyright: string
  disclaimer: string
  tileSrc: string
}

/** The single typed boundary between the reusable UI and the demo content. */
export interface SiteConfig {
  name: string
  header: HeaderConfig
  hero: HeroConfig
  about: AboutConfig
  gallery: GalleryConfig
  featured: FeaturedConfig
  wall: WallConfig
  /** Optional in-page practice arcade; omit to ship a read-only fan page. */
  play?: PlayConfig
  /** Optional read-only fee/liquidity analytics section. */
  analytics?: AnalyticsConfig
  footer: FooterConfig
}
