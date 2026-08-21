import type { SiteConfig } from './types/content'
import { FeaturedFromX } from './components/FeaturedFromX'
import { GallerySection } from './components/GallerySection'
import { HeroSection } from './components/HeroSection'
import { PlaySection } from './components/PlaySection'
import { SiteFooter } from './components/SiteFooter'
import { SiteHeader } from './components/SiteHeader'
import { WallOfLove } from './components/WallOfLove'
import { WhatIsFrongSection } from './components/WhatIsFrongSection'

export default function App({ config }: { config: SiteConfig }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader
        name={config.name}
        brandMarkSrc={config.header.brandMarkSrc}
        navItems={config.header.navItems}
        externalLinks={config.header.externalLinks}
      />
      <main id="main" tabIndex={-1}>
        <HeroSection hero={config.hero} />
        <WhatIsFrongSection about={config.about} />
        <GallerySection gallery={config.gallery} />
        {config.play ? <PlaySection play={config.play} /> : null}
        <FeaturedFromX featured={config.featured} />
        <WallOfLove wall={config.wall} />
      </main>
      <SiteFooter footer={config.footer} />
    </>
  )
}
