import { AnalyticsPage } from './analytics/AnalyticsPage'
import { useAnalyticsRoute, useAnalyticsScrollRestore } from './analytics/useHashRoute'
import { FeaturedFromX } from './components/FeaturedFromX'
import { GallerySection } from './components/GallerySection'
import { HeroSection } from './components/HeroSection'
import { PlaySection } from './components/PlaySection'
import { SiteFooter } from './components/SiteFooter'
import { SiteHeader } from './components/SiteHeader'
import { WallOfLove } from './components/WallOfLove'
import { WhatIsFrongSection } from './components/WhatIsFrongSection'
import type { SiteConfig } from './types/content'

export default function App({ config }: { config: SiteConfig }) {
  const analyticsRoute = useAnalyticsRoute()
  useAnalyticsScrollRestore(analyticsRoute)

  return (
    <div className="page-shell">
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
        {analyticsRoute && config.analytics ? (
          <AnalyticsPage analytics={config.analytics} />
        ) : (
          <>
            <HeroSection hero={config.hero} />
            <WhatIsFrongSection about={config.about} />
            <GallerySection gallery={config.gallery} />
            {config.play ? <PlaySection play={config.play} /> : null}
            <FeaturedFromX featured={config.featured} />
            <WallOfLove wall={config.wall} />
          </>
        )}
      </main>
      <SiteFooter footer={config.footer} />
    </div>
  )
}
