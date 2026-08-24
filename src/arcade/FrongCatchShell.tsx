import { lazy, Suspense, useState } from 'react'
import GameApp from '../game/GameApp'
import type { ArcadeGameRuntimeProps } from './types'
import styles from '../components/PlaySection.module.css'

const PaidApp = lazy(() => import('../paid/PaidApp'))

type FrongMode = 'practice' | 'paid'

/** Adapter that preserves the existing FRONG Catch practice/paid boundary. */
export default function FrongCatchShell({
  initialMode = 'practice',
  onExit,
}: ArcadeGameRuntimeProps) {
  const [mode, setMode] = useState<FrongMode>(initialMode === 'paid' ? 'paid' : 'practice')

  if (mode === 'practice') {
    return (
      <>
        <GameApp labelledBy="play-title" />
        <button type="button" className="btn btn-secondary" onClick={onExit}>
          Back to arcade modes
        </button>
      </>
    )
  }

  return (
    <Suspense
      fallback={
        <div className={styles.card} role="status" aria-busy="true">
          Loading paid game…
        </div>
      }
    >
      <PaidApp embedded onExit={onExit} onPractice={() => setMode('practice')} />
    </Suspense>
  )
}
