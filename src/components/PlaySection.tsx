import { lazy, Suspense, useState } from 'react'
import type { ArcadeGameCardConfig, PlayConfig } from '../types/content'
import { ARCADE_GAME_REGISTRY } from '../arcade/registry'
import type { ArcadeGameId, ArcadeGameRuntimeProps } from '../arcade/types'
import { SectionHeading } from './SectionHeading'
import styles from './PlaySection.module.css'

const GAME_COMPONENTS: Record<
  ArcadeGameId,
  React.LazyExoticComponent<React.ComponentType<ArcadeGameRuntimeProps>>
> = {
  'frong-catch': lazy(ARCADE_GAME_REGISTRY['frong-catch'].load),
  'pond-guardian': lazy(ARCADE_GAME_REGISTRY['pond-guardian'].load),
}

function legacyCards(play: PlayConfig): readonly ArcadeGameCardConfig[] {
  return [
    {
      id: 'frong-catch',
      title: play.title,
      description: play.practiceBlurb,
      badge: 'Practice + trophy run',
      thumbnailSrc: '/assets/avatar.png',
      status: 'available',
    },
  ]
}

export function PlaySection({ play }: { play: PlayConfig }) {
  const [selectedGame, setSelectedGame] = useState<ArcadeGameId | null>(null)
  const [initialMode, setInitialMode] = useState<ArcadeGameRuntimeProps['initialMode']>('attract')
  const cards = play.games ?? legacyCards(play)
  const GameComponent = selectedGame === null ? null : GAME_COMPONENTS[selectedGame]

  const openGame = (id: ArcadeGameId, mode: ArcadeGameRuntimeProps['initialMode']) => {
    setInitialMode(mode)
    setSelectedGame(id)
  }

  const closeGame = () => {
    setSelectedGame(null)
    setInitialMode('attract')
  }

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
          {selectedGame === null && (
            <div className={styles.library} aria-labelledby="play-title">
              {cards.map((card) => (
                <article key={card.id} className={styles.card}>
                  <div className={styles.cardVisual}>
                    <img src={card.thumbnailSrc} alt="" className={styles.cardImage} />
                    <span className={styles.cardBadge}>{card.badge}</span>
                  </div>
                  <h3 className={styles.cardTitle}>{card.title}</h3>
                  <p className={styles.cardBlurb}>{card.description}</p>
                  {card.id === 'frong-catch' ? (
                    <div className={styles.cardActions}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => openGame('frong-catch', 'practice')}
                      >
                        {play.practiceCta}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => openGame('frong-catch', 'paid')}
                      >
                        {play.paidCta}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={card.status !== 'available'}
                      onClick={() => openGame(card.id, 'attract')}
                    >
                      {card.ctaLabel ?? `Play ${card.title}`}
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}

          {selectedGame !== null && GameComponent !== null && (
            <Suspense
              fallback={
                <div className={styles.card} role="status" aria-busy="true">
                  Loading {ARCADE_GAME_REGISTRY[selectedGame].title}…
                </div>
              }
            >
              <GameComponent initialMode={initialMode} onExit={closeGame} />
            </Suspense>
          )}
        </div>
        <p className={styles.note}>{play.note}</p>
      </div>
    </section>
  )
}
