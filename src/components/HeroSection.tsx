import type { CSSProperties } from 'react'
import type { HeroConfig } from '../types/content'
import styles from './HeroSection.module.css'

export function HeroSection({ hero }: { hero: HeroConfig }) {
  // artSize seeds the plate scale; the CSS clamps it into the large,
  // focal-point range instead of a small floating tile.
  const artStyle = { '--hero-art': `${hero.artSize}px` } as CSSProperties

  return (
    <section id="top" className={styles.hero}>
      <div className={`container editorial-grid ${styles.grid}`}>
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
            <a className={`btn btn-primary ${styles.cta}`} href={hero.ctaHref}>
              {hero.ctaLabel}
            </a>
          </div>
          <p className={styles.plumbingWarning}>{hero.disclaimer}</p>
        </div>
        <div className={styles.art} aria-hidden="true">
          <img
            src={hero.artSrc}
            alt={hero.artAlt}
            width={hero.artSize}
            height={hero.artSize}
            style={artStyle}
            className={styles.frog}
          />
        </div>
      </div>
    </section>
  )
}
