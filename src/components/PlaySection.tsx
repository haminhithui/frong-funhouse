import { lazy, Suspense, useState } from 'react'
import type { PlayConfig } from '../types/content'
import GameApp from '../game/GameApp'
import { SectionHeading } from './SectionHeading'
import styles from './PlaySection.module.css'

type Mode = 'menu' | 'practice' | 'paid'

// Keep Privy, WalletConnect, viem wallet clients, and the paid flow out of
// the fan-site initial bundle. The chunk is fetched only after the user opts
// into the paid mode; paid/index.html still imports PaidApp directly.
const PaidApp = lazy(() => import('../paid/PaidApp'))

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
                  className="btn btn-primary"
                  onClick={() => setMode('practice')}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                    <path
                      d="M9 15.5c-3.6 0-6.5-2.9-6.5-6.5S5.4 2.5 9 2.5s6.5 2.9 6.5 6.5-2.9 6.5-6.5 6.5Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                    <path
                      d="M9 2.5c2.6 0 4.5 2.9 4.5 6.5S11.6 15.5 9 15.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                  </svg>
                  {play.practiceCta}
                </button>
              </div>
              <div className={styles.card}>
                <p className={styles.cardBadge}>FRONG entry fee · NFT trophy</p>
                <h3 className={styles.cardTitle}>{play.paidTitle}</h3>
                <p className={styles.cardBlurb}>{play.paidBlurb}</p>
                <button type="button" className="btn btn-primary" onClick={() => setMode('paid')}>
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                    <path
                      d="M4 3h7.5a2 2 0 0 1 2 2v1.5H4V3Zm0 0v3M4 6v6.5A2 2 0 0 0 6 14.5h7.5a2 2 0 0 0 2-2V8H4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                    <path d="M4 8h9.5v2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                  {play.paidCta}
                </button>
              </div>
            </div>
          )}

          {mode === 'practice' && (
            <>
              <GameApp labelledBy="play-title" />
              <button type="button" className="btn btn-secondary" onClick={() => setMode('menu')}>
                Back to arcade modes
              </button>
            </>
          )}

          {mode === 'paid' && (
            <Suspense
              fallback={
                <div className={styles.card} role="status" aria-busy="true">
                  Loading paid game…
                </div>
              }
            >
              <PaidApp
                embedded
                onExit={() => setMode('menu')}
                onPractice={() => setMode('practice')}
              />
            </Suspense>
          )}
        </div>
        <p className={styles.note}>{play.note}</p>
      </div>
    </section>
  )
}
