import type { GalleryConfig } from '../types/content'
import { SectionHeading } from './SectionHeading'
import { XEmbedCard } from './XEmbedCard'
import styles from './GallerySection.module.css'

export function GallerySection({ gallery }: { gallery: GalleryConfig }) {
  return (
    <section id="art" className="section">
      <div className="container">
        <div className={styles.frame}>
          <SectionHeading eyebrow={gallery.eyebrow} title={gallery.title} lede={gallery.lede} />
          <ul className={styles.grid}>
            {gallery.posts.map((post) => (
              <li key={post.id} className={styles.cell}>
                <XEmbedCard post={post} bare />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
