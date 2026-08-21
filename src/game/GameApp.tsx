import { useCallback, useEffect, useRef, useState } from 'react'
import { CanvasStage } from './CanvasStage'
import type { HudSnapshot, RunResult } from './CanvasStage'
import { FLY_COLORS } from './render'
import {
  DEFAULT_COUNTDOWN_TICKS,
  DEFAULT_DURATION_TICKS,
  FLY_TYPES,
  TICKS_PER_SECOND,
  TIERS,
  tierForScore,
} from './sim/constants'
import type { FlyTypeId } from './sim/types'
import { buildShareUrl, loadBestScore, randomSeed, saveBestScore } from './util'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'
import styles from './GameApp.module.css'

type Screen = 'attract' | 'run' | 'results'

const FLY_LABELS: Record<FlyTypeId, string> = {
  gnat: 'Gnat',
  midge: 'Midge',
  drifter: 'Drifter',
  firefly: 'Golden Firefly',
  queen: 'Queen Fly',
}

const FLY_NOTES: Record<FlyTypeId, string> = {
  gnat: 'Straight fall',
  midge: 'Fast, small',
  drifter: 'Drifts wide',
  firefly: 'Fast, glowing',
  queen: 'Erratic jackpot',
}

interface GameAppProps {
  /** Overridable for tests; defaults match the design doc (60s run, 3s countdown). */
  durationTicks?: number
  countdownTicks?: number
  /** id of the section heading that labels the attract panel when embedded in a page. */
  labelledBy?: string
}

/** Small inline glyph per fly type — matches the canvas silhouettes (shape, never color alone). */
function FlyGlyph({ type }: { type: FlyTypeId }) {
  const color = FLY_COLORS[type]
  switch (type) {
    case 'gnat':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <ellipse
            cx="8.5"
            cy="11"
            rx="4.5"
            ry="2.6"
            transform="rotate(-28 8.5 11)"
            fill={color}
            opacity="0.55"
          />
          <ellipse
            cx="19.5"
            cy="11"
            rx="4.5"
            ry="2.6"
            transform="rotate(28 19.5 11)"
            fill={color}
            opacity="0.55"
          />
          <circle cx="14" cy="15.5" r="5.4" fill={color} />
        </svg>
      )
    case 'midge':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <ellipse cx="14" cy="14" rx="3.6" ry="8" fill={color} />
        </svg>
      )
    case 'drifter':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <circle cx="14" cy="14" r="7" fill={color} />
          <rect x="7" y="12.6" width="14" height="2.8" rx="1.4" fill="#0b0d0c" />
        </svg>
      )
    case 'firefly':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <circle cx="14" cy="14" r="7.4" fill={color} opacity="0.35" />
          <circle cx="14" cy="14" r="5" fill={color} />
          <circle cx="14" cy="14" r="2.2" fill="#101a08" />
        </svg>
      )
    case 'queen':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <circle cx="14" cy="16" r="6.4" fill={color} />
          <path
            d="M8.6 13.9 L10.7 7.8 L12.8 13.9 L14.9 7.8 L17 13.9 L19.1 7.8 L21 13.6 L21 15.6 L8.6 15.6 Z"
            fill={color}
          />
        </svg>
      )
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export default function GameApp({ durationTicks, countdownTicks, labelledBy }: GameAppProps) {
  const [screen, setScreen] = useState<Screen>('attract')
  const [paused, setPaused] = useState(false)
  const [runId, setRunId] = useState(0)
  const [seed, setSeed] = useState<number>(() => randomSeed())
  const [hud, setHud] = useState<HudSnapshot>({
    phase: 'countdown',
    countdownLeft: countdownTicks ?? DEFAULT_COUNTDOWN_TICKS,
    score: 0,
    caught: 0,
    timeLeft: Math.ceil((durationTicks ?? DEFAULT_DURATION_TICKS) / TICKS_PER_SECOND),
  })
  const [result, setResult] = useState<RunResult | null>(null)
  const [beatBest, setBeatBest] = useState(false)
  const [best, setBest] = useState<number>(() => loadBestScore())
  const [announce, setAnnounce] = useState('')
  const bestRef = useRef<number>(best)
  const lastTierRef = useRef(0)
  const prevScreenRef = useRef<Screen>('attract')
  const attractRef = useRef<HTMLDivElement | null>(null)
  const resultsRef = useRef<HTMLHeadingElement | null>(null)
  const runRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  const startRun = useCallback(() => {
    setSeed(randomSeed())
    setRunId((id) => id + 1)
    setResult(null)
    setBeatBest(false)
    setPaused(false)
    lastTierRef.current = 0
    setHud({
      phase: 'countdown',
      countdownLeft: countdownTicks ?? DEFAULT_COUNTDOWN_TICKS,
      score: 0,
      caught: 0,
      timeLeft: Math.ceil((durationTicks ?? DEFAULT_DURATION_TICKS) / TICKS_PER_SECOND),
    })
    setAnnounce('Run started. Move the lily pad and catch as many flies as you can.')
    setScreen('run')
  }, [countdownTicks, durationTicks])

  const finishRun = useCallback((runResult: RunResult) => {
    const beaten = runResult.score > bestRef.current && bestRef.current > 0
    bestRef.current = Math.max(bestRef.current, runResult.score)
    setBeatBest(beaten)
    setResult(runResult)
    setScreen('results')
    const tierName = TIERS[tierForScore(runResult.score)].name
    setAnnounce(
      'Run over. You caught ' +
        runResult.caught +
        ' of 45 flies and scored ' +
        runResult.score +
        ' of 109. Tier: ' +
        tierName +
        '.' +
        (beaten ? ' New best score.' : ''),
    )
    setBest((previous) => {
      const next = Math.max(previous, runResult.score)
      if (next > previous) saveBestScore(next)
      return next
    })
  }, [])

  const quitRun = useCallback(() => {
    setPaused(false)
    setScreen('attract')
    setAnnounce('Back to the pond. Ready when you are.')
  }, [])

  // Announce tier crossings (only — per-catch chatter is worse than silence).
  useEffect(() => {
    if (screen !== 'run') return
    const tier = tierForScore(hud.score)
    if (tier > lastTierRef.current) {
      lastTierRef.current = tier
      setAnnounce(TIERS[tier].name + ' tier reached')
    }
  }, [hud.score, screen])

  // Move focus with the screen: run stage on start, results heading on
  // finish, attract panel on quit.
  useEffect(() => {
    if (screen === 'run') {
      runRef.current?.focus()
    } else if (screen === 'results') {
      resultsRef.current?.focus()
    } else if (screen === 'attract' && prevScreenRef.current !== 'attract') {
      attractRef.current?.focus()
    }
    prevScreenRef.current = screen
  }, [screen])

  // Auto-pause when the page loses focus or the tab is hidden.
  useEffect(() => {
    if (screen !== 'run') return
    const onBlur = () => setPaused(true)
    const onVisibility = () => {
      if (document.hidden) setPaused(true)
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [screen])

  // P or Escape toggles pause during a run.
  useEffect(() => {
    if (screen !== 'run') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'p' || event.key === 'P' || event.key === 'Escape') {
        setPaused((p) => !p)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [screen])

  const tierName = result === null ? null : TIERS[tierForScore(result.score)].name
  const bestTierName = best > 0 ? TIERS[tierForScore(best)].name : null
  const bestTierIndex = best > 0 ? tierForScore(best) : -1

  const hudTierIndex = tierForScore(hud.score)
  const hudTier = TIERS[hudTierIndex]
  const hudNextTier = TIERS[hudTierIndex + 1] ?? null
  const tierProgress = hudNextTier ? (hud.score - hudTier.min) / (hudNextTier.min - hudTier.min) : 1
  const progressPct = Math.round(clamp01(tierProgress) * 100)

  return (
    <div className={styles.arcade}>
      <div role="status" className="visually-hidden">
        {announce}
      </div>

      <div className={styles.strip}>
        <span className={styles.badge}>Practice mode</span>
        <span className={styles.stripMeta}>Free · no wallet · scores stay on this device</span>
      </div>

      {screen === 'attract' && (
        <div ref={attractRef} className={styles.attract} tabIndex={-1} aria-labelledby={labelledBy}>
          {labelledBy ? null : (
            <h3 className={styles.title}>
              FRONG <span className={styles.accent}>Catch</span>
            </h3>
          )}
          <p className={styles.lede}>
            One minute. Forty-five flies. Move FRONG&apos;s lily pad and catch what falls — the
            rarer the fly, the more points. A perfect run is 109.
          </p>
          <ul className={styles.legend} aria-label="Fly types and points">
            {FLY_TYPES.map((fly) => (
              <li key={fly.id} className={styles.legendItem}>
                <FlyGlyph type={fly.id} />
                <span className={styles.legendName}>{FLY_LABELS[fly.id]}</span>
                <span className={styles.legendPoints}>+{fly.points}</span>
                <span className={styles.legendNote}>{FLY_NOTES[fly.id]}</span>
              </li>
            ))}
          </ul>
          <ul className={styles.tiers} aria-label="Score tiers">
            {TIERS.map((tier, index) => (
              <li
                key={tier.name}
                className={
                  index === bestTierIndex
                    ? styles.tierItem + ' ' + styles.tierItemBest
                    : styles.tierItem
                }
              >
                <span className={styles.tierName}>{tier.name}</span>
                <span className={styles.tierMin}>
                  {tier.min === 0 ? 'any score' : tier.min + '+'}
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={startRun}>
              Play
            </button>
          </div>
          {best > 0 && bestTierName !== null && (
            <p className={styles.best}>
              Your best: <strong>{best}</strong> ({bestTierName})
            </p>
          )}
          <p className={styles.help}>Move: mouse, touch, or ← → arrow keys. Pause: P or Esc.</p>
        </div>
      )}

      {screen === 'run' && (
        <div className={styles.run} ref={runRef} tabIndex={-1} aria-label="Game run">
          <div className={styles.hud}>
            <span className={styles.hudStat}>
              Score <strong className={styles.hudStrong}>{hud.score}</strong>
            </span>
            <span className={styles.hudStat}>
              Flies <strong className={styles.hudStrong}>{hud.caught}/45</strong>
            </span>
            <span className={styles.hudStat}>
              Time <strong className={styles.hudStrong}>{hud.timeLeft}s</strong>
            </span>
          </div>
          <div className={styles.progress} aria-hidden="true">
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: progressPct + '%' }} />
            </div>
            <div className={styles.progressMeta}>
              <span className={styles.progressTier}>{hudTier.name}</span>
              <span className={styles.progressNext}>
                {hudNextTier
                  ? 'Next: ' + hudNextTier.name + ' at ' + hudNextTier.min
                  : 'Perfect run'}
              </span>
            </div>
          </div>
          <span className="visually-hidden">Current tier: {hudTier.name}</span>
          <div className={styles.stageWrap}>
            <CanvasStage
              key={runId}
              seed={seed}
              durationTicks={durationTicks}
              countdownTicks={countdownTicks}
              paused={paused}
              reducedMotion={reducedMotion}
              className={styles.stageInner}
              onHud={setHud}
              onFinish={finishRun}
            />
            {hud.phase === 'countdown' && !paused && (
              <div className={styles.overlay} aria-hidden="true">
                <span className={styles.getReady}>Get ready</span>
                <span className={styles.countdown}>
                  {Math.ceil(hud.countdownLeft / TICKS_PER_SECOND)}
                </span>
              </div>
            )}
            {paused && (
              <div className={styles.overlay}>
                <p className={styles.pauseTitle}>Paused</p>
                <div className={styles.actions}>
                  <button type="button" className={styles.button} onClick={() => setPaused(false)}>
                    Resume
                  </button>
                  <button type="button" className={styles.buttonSecondary} onClick={startRun}>
                    Restart
                  </button>
                  <button type="button" className={styles.buttonGhost} onClick={quitRun}>
                    Quit
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {screen === 'results' && result !== null && tierName !== null && (
        <div className={styles.results} aria-labelledby="results-title">
          <p className="eyebrow">Run over</p>
          <h3 id="results-title" ref={resultsRef} tabIndex={-1} className={styles.resultTier}>
            {tierName}
          </h3>
          {beatBest && <p className={styles.newBest}>New best score</p>}
          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>Score</dt>
              <dd className={styles.statValue}>
                {result.score}
                <span className={styles.statUnit}>/109</span>
              </dd>
            </div>
            <div className={styles.stat}>
              <dt>Flies</dt>
              <dd className={styles.statValue}>
                {result.caught}
                <span className={styles.statUnit}>/45</span>
              </dd>
            </div>
            <div className={styles.stat}>
              <dt>Missed</dt>
              <dd className={styles.statValue}>{result.missed}</dd>
            </div>
            <div className={styles.stat}>
              <dt>Best</dt>
              <dd className={styles.statValue}>{best}</dd>
            </div>
          </dl>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={startRun}>
              Play again
            </button>
            <a
              className={styles.buttonSecondary}
              href={buildShareUrl(result.score, result.caught, tierName)}
              target="_blank"
              rel="noreferrer"
            >
              Share on X
            </a>
          </div>
          <p className={styles.help}>
            Practice mode — scores stay on this device. No prizes, just pond pride.
          </p>
        </div>
      )}
    </div>
  )
}
