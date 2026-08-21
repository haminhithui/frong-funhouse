import type { AboutConfig } from '../types/content'
import { CopyButton } from './CopyButton'
import { SectionHeading } from './SectionHeading'
import styles from './WhatIsFrongSection.module.css'

export function WhatIsFrongSection({ about }: { about: AboutConfig }) {
  return (
    <section id="about" className="section">
      <div className="container">
        <SectionHeading eyebrow={about.eyebrow} title={about.title} lede={about.lede} />
        <aside className={`${styles.chainNote} panel`} aria-labelledby="chain-note-title">
          <h3 id="chain-note-title" className={styles.chainTitle}>
            {about.chainTitle}
          </h3>
          <p className={styles.chainText}>{about.chainText}</p>
          <div className={styles.contractRow}>
            <code className={styles.contract}>{about.contractAddress}</code>
            <CopyButton value={about.contractAddress} />
          </div>
          <p className={styles.fine}>{about.fineText}</p>
        </aside>
      </div>
    </section>
  )
}
