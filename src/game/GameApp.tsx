import { useCallback, useEffect, useRef, useState } from 'react'
import arcade from './arcade.module.css'
import { CanvasStage } from './CanvasStage'
import type { HudSnapshot, RunResult } from './CanvasStage'
import { FlyGlyph } from './FlyGlyph'
import { FLY_LABELS, FLY_NOTES } from './flyCopy'
import {
  DEFAULT_COUNTDOWN_TICKS,
  DEFAULT_DURATION_TICKS,
  FLY_TYPES,
  TICKS_PER_SECOND,
  TIERS,
  tierForScore,
} from './sim/constants'
import { TIER_FLAVOR } from './tierCopy'
import { buildShareUrl, loadBestScore, randomSeed, saveBestScore } from './util'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

type Screen = 'attract' | 'run' | 'results'

interface GameAppProps {
  /** Overridable for tests; defaults match the design doc (60s run, 3s countdown). */
  durationTicks?: number
  countdownTicks?: number
  /** id of the section heading that labels the attract panel when embedded in a page. */
  labelledBy?: string
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
  const pauseCardRef = useRef<HTMLDivElement | null>(null)
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

  const resumeRun = useCallback(() => {
    setPaused(false)
    runRef.current?.focus()
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

  // Count the countdown out loud once per second.
  useEffect(() => {
    if (screen !== 'run' || hud.phase !== 'countdown' || hud.countdownLeft <= 0) return
    setAnnounce(String(Math.ceil(hud.countdownLeft / TICKS_PER_SECOND)))
  }, [screen, hud.phase, hud.countdownLeft])

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

  // Pause dialog: focus Resume on open, trap Tab inside, return focus on close.
  useEffect(() => {
    if (screen !== 'run') return
    if (paused) {
      pauseCardRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Tab') return
        const card = pauseCardRef.current
        if (!card) return
        const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>('button'))
        if (buttons.length === 0) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }
    runRef.current?.focus()
  }, [paused, screen])

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

  const timeStatClass =
    hud.timeLeft <= 5
      ? arcade.hudStatDanger
      : hud.timeLeft <= 10
        ? arcade.hudStatWarn
        : arcade.hudStat

  return (
    <div className={arcade.shell}>
      <div role="status" className="visually-hidden">
        {announce}
      </div>

      <div className={arcade.strip}>
        <span className={arcade.badge}>Practice mode</span>
        <span className={arcade.stripMeta}>Free · no wallet · scores stay on this device</span>
      </div>

      {screen === 'attract' && (
        <div
          ref={attractRef}
          className={arcade.attract + ' ' + arcade.screenIn}
          tabIndex={-1}
          aria-labelledby={labelledBy}
        >
          {labelledBy ? null : (
            <h3 className={arcade.title}>
              FRONG <span className={arcade.accent}>Catch</span>
            </h3>
          )}
          <p className={arcade.lede}>
            One minute. Forty-five flies. Move FRONG&apos;s lily pad and catch what falls — the
            rarer the fly, the more points. A perfect run is 109.
          </p>
          <ul className={arcade.legend} aria-label="Fly types and points">
            {FLY_TYPES.map((fly) => (
              <li key={fly.id} className={arcade.legendItem}>
                <FlyGlyph type={fly.id} />
                <span className={arcade.legendName}>{FLY_LABELS[fly.id]}</span>
                <span className={arcade.legendPoints}>+{fly.points}</span>
                <span className={arcade.legendNote}>{FLY_NOTES[fly.id]}</span>
              </li>
            ))}
          </ul>
          <ul className={arcade.tiers} aria-label="Score tiers">
            {TIERS.map((tier, index) => (
              <li
                key={tier.name}
                className={
                  index === bestTierIndex
                    ? arcade.tierItem + ' ' + arcade.tierItemBest
                    : arcade.tierItem
                }
              >
                <span className={arcade.tierName}>{tier.name}</span>
                <span className={arcade.tierMin}>
                  {tier.min === 0 ? 'any score' : tier.min + '+'}
                </span>
              </li>
            ))}
          </ul>
          <div className={arcade.actions}>
            <button type="button" className="btn btn-primary" onClick={startRun}>
              Play
            </button>
          </div>
          {best > 0 && bestTierName !== null && (
            <p className={arcade.best}>
              Your best: <strong>{best}</strong> ({bestTierName})
            </p>
          )}
          <p className={arcade.help}>
            Move: mouse, touch, or ← → arrow keys. Pause: <kbd className="kbd">P</kbd> or{' '}
            <kbd className="kbd">Esc</kbd>.
          </p>
        </div>
      )}

      {screen === 'run' && (
        <div
          className={arcade.run + ' ' + arcade.screenIn}
          ref={runRef}
          tabIndex={-1}
          aria-label="Game run"
        >
          <div className={arcade.hud}>
            <div className={arcade.hudStats}>
              <span className={arcade.hudStat}>
                Score{' '}
                <strong key={hud.score} className={arcade.hudStrong + ' ' + arcade.hudStrongPop}>
                  {hud.score}
                </strong>
              </span>
              <span className={arcade.hudStat}>
                Flies <strong className={arcade.hudStrong}>{hud.caught}/45</strong>
              </span>
              <span className={timeStatClass}>
                Time <strong className={arcade.hudStrong}>{hud.timeLeft}s</strong>
              </span>
            </div>
            <button
              type="button"
              className={arcade.hudPause}
              aria-label="Pause game"
              onClick={() => setPaused(true)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="2.5" y="2" width="4" height="12" rx="1" fill="currentColor" />
                <rect x="9.5" y="2" width="4" height="12" rx="1" fill="currentColor" />
              </svg>
            </button>
          </div>
          <div className={arcade.progress} aria-hidden="true">
            <div className={arcade.progressTrack}>
              <div className={arcade.progressFill} style={{ width: progressPct + '%' }} />
            </div>
            <div className={arcade.progressMeta}>
              <span
                key={hudTier.name}
                className={arcade.progressTier + ' ' + arcade.progressTierPop}
              >
                {hudTier.name}
              </span>
              <span className={arcade.progressNext}>
                {hudNextTier
                  ? 'Next: ' + hudNextTier.name + ' at ' + hudNextTier.min
                  : 'Perfect run'}
              </span>
            </div>
          </div>
          <span className="visually-hidden">Current tier: {hudTier.name}</span>
          <div className={arcade.stageWrap}>
            <CanvasStage
              key={runId}
              seed={seed}
              durationTicks={durationTicks}
              countdownTicks={countdownTicks}
              paused={paused}
              reducedMotion={reducedMotion}
              className={arcade.stageInner}
              onHud={setHud}
              onFinish={finishRun}
            />
            {hud.phase === 'countdown' && !paused && (
              <div className={arcade.overlay} aria-hidden="true">
                <span className={arcade.getReady}>Get ready</span>
                <span
                  key={Math.ceil(hud.countdownLeft / TICKS_PER_SECOND)}
                  className={arcade.countdown}
                >
                  {Math.ceil(hud.countdownLeft / TICKS_PER_SECOND)}
                </span>
              </div>
            )}
            {paused && (
              <div
                className={arcade.overlay}
                role="dialog"
                aria-modal="true"
                aria-label="Pause menu"
              >
                <div className={arcade.pauseCard} ref={pauseCardRef}>
                  <p className={arcade.pauseTitle}>Paused</p>
                  <div className={arcade.actions}>
                    <button type="button" className="btn btn-primary" onClick={resumeRun}>
                      Resume
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={startRun}>
                      Restart
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={quitRun}>
                      Quit
                    </button>
                  </div>
                  <p className={arcade.pauseHint}>
                    <kbd className="kbd">P</kbd> or <kbd className="kbd">Esc</kbd> to resume
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {screen === 'results' && result !== null && tierName !== null && (
        <div className={arcade.results + ' ' + arcade.screenIn} aria-labelledby="results-title">
          <p className="eyebrow">Run over</p>
          <h3 id="results-title" ref={resultsRef} tabIndex={-1} className={arcade.resultTier}>
            {tierName}
          </h3>
          {beatBest && <p className={arcade.newBest}>New best score</p>}
          <p className={arcade.flavor}>{TIER_FLAVOR[tierName]}</p>
          <dl className={arcade.stats}>
            <div className={arcade.stat}>
              <dt>Score</dt>
              <dd className={arcade.statValue}>
                {result.score}
                <span className={arcade.statUnit}>/109</span>
              </dd>
            </div>
            <div className={arcade.stat}>
              <dt>Flies</dt>
              <dd className={arcade.statValue}>
                {result.caught}
                <span className={arcade.statUnit}>/45</span>
              </dd>
            </div>
            <div className={arcade.stat}>
              <dt>Missed</dt>
              <dd className={arcade.statValue}>{result.missed}</dd>
            </div>
            <div className={arcade.stat}>
              <dt>Best</dt>
              <dd className={arcade.statValue}>{best}</dd>
            </div>
          </dl>
          <ul className={arcade.tiers} aria-label="Score tiers">
            {TIERS.map((tier, index) => (
              <li
                key={tier.name}
                className={
                  index === tierForScore(result.score)
                    ? arcade.tierItem + ' ' + arcade.tierItemBest
                    : arcade.tierItem
                }
              >
                <span className={arcade.tierName}>{tier.name}</span>
                <span className={arcade.tierMin}>
                  {tier.min === 0 ? 'any score' : tier.min + '+'}
                </span>
              </li>
            ))}
          </ul>
          <div className={arcade.actions}>
            <button type="button" className="btn btn-primary" onClick={startRun}>
              Play again
            </button>
            <a
              className="btn btn-secondary"
              href={buildShareUrl(result.score, result.caught, tierName)}
              target="_blank"
              rel="noreferrer"
            >
              Share on X
            </a>
          </div>
          <p className={arcade.help}>
            Practice mode — scores stay on this device. No prizes, just pond pride.
          </p>
        </div>
      )}
    </div>
  )
}
