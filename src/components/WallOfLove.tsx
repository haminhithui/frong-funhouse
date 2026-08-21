import type { WallConfig } from '../types/content'
import { SectionHeading } from './SectionHeading'
import { XEmbedCard } from './XEmbedCard'
import styles from './WallOfLove.module.css'

export function WallOfLove({ wall }: { wall: WallConfig }) {
  return (
    <section id="community" className="section">
      <div className="container">
        <SectionHeading eyebrow={wall.eyebrow} title={wall.title} lede={wall.lede} />
        <ul className={styles.grid}>
          {wall.posts.map((post) => (
            <li key={post.id} className={styles.cell}>
              <XEmbedCard post={post} bare />
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
