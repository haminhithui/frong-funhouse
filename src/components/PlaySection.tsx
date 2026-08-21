import { useState } from 'react'
import type { PlayConfig } from '../types/content'
import GameApp from '../game/GameApp'
import PaidApp from '../paid/PaidApp'
import { SectionHeading } from './SectionHeading'
import styles from './PlaySection.module.css'

type Mode = 'menu' | 'practice' | 'paid'

/**
 * The in-page arcade with both modes: free practice (no wallet, no server)
 * and the paid trophy run (wallet → FRONG entry fee → replay-verified run →
 * ERC-721 trophy). Wallet UI never appears until the player explicitly picks
 * the trophy run. The game panel is labelled by the section heading, so the
 * page has exactly one "FRONG Catch" heading.
 */
export function PlaySection({ play }: { play: PlayConfig }) {
  const [mode, setMode] = useState<Mode>('menu')

  return (
    <section id="play" className={'section ' + styles.band}>
      <div className="container">
        <SectionHeading
          eyebrow={play.eyebrow}
          title={play.title}
          lede={play.lede}
          titleId="play-title"
        />
        <div className={styles.wrap}>
          {mode === 'menu' && (
            <div className={styles.menu} aria-labelledby="play-title">
              <div className={styles.card}>
                <p className={styles.cardBadge}>Free · no wallet</p>
                <h3 className={styles.cardTitle}>{play.practiceTitle}</h3>
                <p className={styles.cardBlurb}>{play.practiceBlurb}</p>
                <button
                  type="button"
                  className={styles.cardCta}
                  onClick={() => setMode('practice')}
                >
                  {play.practiceCta}
                </button>
              </div>
              <div className={styles.card}>
                <p className={styles.cardBadge}>FRONG entry fee · NFT trophy</p>
                <h3 className={styles.cardTitle}>{play.paidTitle}</h3>
                <p className={styles.cardBlurb}>{play.paidBlurb}</p>
                <button type="button" className={styles.cardCta} onClick={() => setMode('paid')}>
                  {play.paidCta}
                </button>
              </div>
            </div>
          )}

          {mode === 'practice' && (
            <>
              <GameApp labelledBy="play-title" />
              <button type="button" className={styles.modeSwitch} onClick={() => setMode('menu')}>
                Back to arcade modes
              </button>
            </>
          )}

          {mode === 'paid' && (
            <PaidApp
              embedded
              onExit={() => setMode('menu')}
              onPractice={() => setMode('practice')}
            />
          )}
        </div>
        <p className={styles.note}>{play.note}</p>
      </div>
    </section>
  )
}
