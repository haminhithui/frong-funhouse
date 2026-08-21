import type { FeaturedConfig } from '../types/content'
import { SectionHeading } from './SectionHeading'
import { XEmbedCard } from './XEmbedCard'
import styles from './FeaturedFromX.module.css'

export function FeaturedFromX({ featured }: { featured: FeaturedConfig }) {
  return (
    <section id="featured" className="section">
      <div className="container">
        <SectionHeading eyebrow={featured.eyebrow} title={featured.title} lede={featured.lede} />
        <div className={styles.wrap}>
          <XEmbedCard post={featured.post} flush />
        </div>
      </div>
    </section>
  )
}
