import type { HeroConfig } from '../types/content'
import { FrongTile } from './FrongTile'
import styles from './HeroSection.module.css'

export function HeroSection({ hero }: { hero: HeroConfig }) {
  return (
    <section id="top" className={styles.hero}>
      <div className={`container ${styles.grid}`}>
        <div className={styles.copy}>
          <p className="eyebrow">{hero.eyebrow}</p>
          <h1 className={styles.title}>
            {hero.titlePrefix}
            <span className={styles.accent}>{hero.titleAccent}</span>
            {hero.titleSuffix}
            <span className={styles.secondLine}>{hero.titleSecondLine}</span>
          </h1>
          <p className={styles.support}>{hero.support}</p>
          <div className={styles.actions}>
            <a className={styles.primary} href={hero.ctaHref}>
              {hero.ctaLabel}
            </a>
          </div>
          <p className={styles.plumbingWarning}>{hero.disclaimer}</p>
        </div>
        <div className={styles.art} aria-hidden="true">
          <FrongTile
            src={hero.artSrc}
            alt={hero.artAlt}
            size={hero.artSize}
            className={styles.frog}
          />
        </div>
      </div>
    </section>
  )
}
