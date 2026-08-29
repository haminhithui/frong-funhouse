import type { AboutConfig } from '../types/content'
import { CopyButton } from './CopyButton'
import { SectionHeading } from './SectionHeading'
import styles from './WhatIsFrongSection.module.css'

export function WhatIsFrongSection({ about }: { about: AboutConfig }) {
  return (
    <section id="about" className="section">
      <div className="container">
        <div className={styles.frame}>
          <div className={styles.intro}>
            <SectionHeading eyebrow={about.eyebrow} title={about.title} lede={about.lede} />
          </div>
          <aside className={styles.chainNote} aria-labelledby="chain-note-title">
            <div className={styles.noteBody}>
              <h3 id="chain-note-title" className={styles.chainTitle}>
                {about.chainTitle}
              </h3>
              <p className={styles.chainText}>{about.chainText}</p>
            </div>
            <div className={styles.contractBlock}>
              <div className={styles.contractRow}>
                <code className={styles.contract}>{about.contractAddress}</code>
                <CopyButton value={about.contractAddress} />
              </div>
              <p className={styles.fine}>{about.fineText}</p>
            </div>
          </aside>
        </div>
      </div>
    </section>
  )
}
