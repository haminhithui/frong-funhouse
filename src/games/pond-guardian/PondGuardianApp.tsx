import { useEffect, useRef, useState } from 'react'
import type { ArcadeGameRuntimeProps } from '../../arcade/types'
import {
  DEFAULT_DURATION_TICKS,
  FROG_MAX_HEALTH,
  PLAYER_MAX_HEALTH,
  TICKS_PER_SECOND,
} from './sim/constants'
import { randomSeed } from './sim/rng'
import type { PondGuardianEvent, PondGuardianResult } from './sim/types'
import { PondGuardianStage, type PondGuardianHudSnapshot } from './PondGuardianStage'
import styles from './pondGuardian.module.css'

const BEST_SCORE_KEY = 'pond-guardian-best-score-v1'

function loadBestScore(): number {
  if (typeof window === 'undefined') return 0
  const raw = window.localStorage.getItem(BEST_SCORE_KEY)
  const value = raw === null ? 0 : Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function saveBestScore(score: number): void {
  try {
    window.localStorage.setItem(BEST_SCORE_KEY, String(score))
  } catch {
    // Private browsing and blocked storage should not stop a local game.
  }
}

function initialHud(): PondGuardianHudSnapshot {
  return {
    status: 'playing',
    phase: 1,
    timeLeft: Math.ceil(DEFAULT_DURATION_TICKS / TICKS_PER_SECOND),
    score: FROG_MAX_HEALTH * 25,
    kills: 0,
    threats: 0,
    projectiles: 0,
    phaseProgress: 0,
    frogHealth: FROG_MAX_HEALTH,
    frogMaxHealth: FROG_MAX_HEALTH,
    playerHealth: PLAYER_MAX_HEALTH,
    playerMaxHealth: PLAYER_MAX_HEALTH,
  }
}

function eventAnnouncement(event: PondGuardianEvent): string {
  if (event.kind === 'phase')
    return `Phase ${event.phase ?? 1} begins. The swamp is getting louder.`
  if (event.kind === 'frog-hit') return 'The frog is under attack.'
  if (event.kind === 'victory') return 'Victory. The pond held.'
  if (event.kind === 'defeat') return 'Defeat. The pond needs another guardian.'
  return ''
}

export default function PondGuardianApp({ onExit }: ArcadeGameRuntimeProps) {
  const [screen, setScreen] = useState<'attract' | 'run' | 'results'>('attract')
  const [paused, setPaused] = useState(false)
  const [runId, setRunId] = useState(0)
  const [seed, setSeed] = useState(() => randomSeed())
  const [hud, setHud] = useState<PondGuardianHudSnapshot>(initialHud)
  const [result, setResult] = useState<PondGuardianResult | null>(null)
  const [announce, setAnnounce] = useState('')
  const [best, setBest] = useState(loadBestScore)
  const [confirmQuit, setConfirmQuit] = useState(false)
  const bestRef = useRef(best)
  const attractRef = useRef<HTMLDivElement | null>(null)
  const runRef = useRef<HTMLDivElement | null>(null)
  const resultsRef = useRef<HTMLHeadingElement | null>(null)
  const quitConfirmRef = useRef<HTMLHeadingElement | null>(null)

  const startRun = () => {
    setSeed(randomSeed())
    setRunId((current) => current + 1)
    setResult(null)
    setHud(initialHud())
    setPaused(false)
    setConfirmQuit(false)
    setAnnounce('')
    setScreen('run')
  }

  const finishRun = (runResult: PondGuardianResult) => {
    const beatBest = runResult.score > bestRef.current
    if (beatBest) {
      bestRef.current = runResult.score
      setBest(runResult.score)
      saveBestScore(runResult.score)
    }
    setResult(runResult)
    setPaused(false)
    setConfirmQuit(false)
    setScreen('results')
    setAnnounce(
      runResult.outcome === 'victory'
        ? `Victory. Score ${runResult.score}. ${runResult.kills} enemies defeated.`
        : `Defeat. Score ${runResult.score}. The frog had ${runResult.frogHealth} health left.`,
    )
  }

  useEffect(() => {
    if (screen === 'run') {
      runRef.current?.focus()
      runRef.current?.scrollIntoView?.({ block: 'start' })
    } else if (screen === 'results') {
      resultsRef.current?.focus()
      resultsRef.current?.scrollIntoView?.({ block: 'center' })
    } else {
      attractRef.current?.focus()
      attractRef.current?.scrollIntoView?.({ block: 'start' })
    }
  }, [screen])

  useEffect(() => {
    if (confirmQuit) quitConfirmRef.current?.focus()
  }, [confirmQuit])

  useEffect(() => {
    if (screen === 'run' && paused) setAnnounce('Game paused.')
  }, [paused, screen])

  useEffect(() => {
    if (screen !== 'run') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'p' || event.key === 'P' || event.key === 'Escape') {
        event.preventDefault()
        setPaused((current) => !current)
      }
    }
    const onBlur = () => setPaused(true)
    const onVisibilityChange = () => {
      if (document.hidden) setPaused(true)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [screen])

  return (
    <div className={styles.shell}>
      <div role="status" aria-live="polite" aria-atomic="true" className="visually-hidden">
        {announce}
      </div>
      <div className={styles.strip}>
        <span className={styles.badge}>Free · no wallet</span>
        <span className={styles.stripMeta}>Pond Guardian · local best score</span>
      </div>

      {screen === 'attract' && (
        <div
          ref={attractRef}
          tabIndex={-1}
          className={styles.attract + ' ' + styles.screenIn}
          role="region"
          aria-label="Pond Guardian mission briefing"
          data-surface="pond-guardian"
        >
          <div className={styles.missionHeader}>
            <div>
              <span className={styles.missionCode}>MISSION // HOLD THE CENTER</span>
              <strong>PROTECT THE FROG</strong>
            </div>
            <span className={styles.missionStatus}>
              <span className={styles.missionDot} aria-hidden="true" />
              LOCAL DEFENSE
            </span>
          </div>
          <div className={styles.attractHero}>
            <img
              className={styles.heroArt}
              src="/assets/games/pond-guardian/hero-3d-v1.webp"
              alt=""
            />
            <span className={styles.heroAtmosphere} aria-hidden="true" />
            <div className={styles.attractCopy}>
              <p className={styles.eyebrow}>Sculpted ink · bioluminescent swamp</p>
              <h3 id="pond-guardian-title" className={styles.title}>
                Pond <span className={styles.accent}>Guardian</span>
              </h3>
              <p className={styles.lede}>
                A weathered guardian. One tiny frog. Ninety seconds before the whole mire closes in.
              </p>
            </div>
            <span className={styles.previewLabel}>Original 3D visual target · 4:3</span>
          </div>
          <div className={styles.missionStats} aria-label="Mission telemetry">
            <div>
              <strong>90 SEC</strong>
              <span>hold the line</span>
            </div>
            <div>
              <strong>3 PHASES</strong>
              <span>pressure escalates</span>
            </div>
            <div>
              <strong>4 THREATS</strong>
              <span>read the silhouettes</span>
            </div>
          </div>
          <div className={styles.objective}>
            <span className={styles.objectiveKicker}>Primary objective · 90 seconds</span>
            <strong>Stand between the frog and everything in the dark.</strong>
            <span>Read each silhouette, break curved projectiles, and keep the center alive.</span>
          </div>
          <div className={styles.rules}>
            <div>
              <span className={styles.ruleLabel}>Desktop</span>
              <span>WASD / arrows move · mouse aims · click or Space attacks</span>
            </div>
            <div>
              <span className={styles.ruleLabel}>Gamepad</span>
              <span>Left stick moves · right stick aims · A / RT attacks</span>
            </div>
            <div>
              <span className={styles.ruleLabel}>Touch</span>
              <span>Left stick moves · right stick aims · Axe attacks</span>
            </div>
          </div>
          <div className={styles.threatGrid} aria-label="Threat roster">
            <div className={styles.threatCard}>
              <span className={styles.threatIndex}>01</span>
              <strong>Mireling</strong>
              <span>Swarm pressure</span>
            </div>
            <div className={styles.threatCard}>
              <span className={styles.threatIndex}>02</span>
              <strong>Leaper</strong>
              <span>Sudden lunges</span>
            </div>
            <div className={styles.threatCard}>
              <span className={styles.threatIndex}>03</span>
              <strong>Sporecaster</strong>
              <span>Curved spores + needles</span>
            </div>
            <div className={styles.threatCard}>
              <span className={styles.threatIndex}>04</span>
              <strong>Brute</strong>
              <span>Expanding shockwave</span>
            </div>
          </div>
          <div className={styles.startRow}>
            <button type="button" className="btn btn-primary" onClick={startRun}>
              Play Pond Guardian
            </button>
            <button type="button" className="btn btn-secondary" onClick={onExit}>
              Back to arcade
            </button>
          </div>
          <p className={styles.help}>
            Best score: <strong>{best}</strong> · Pause with <kbd className="kbd">P</kbd> or{' '}
            <kbd className="kbd">Esc</kbd>.
          </p>
        </div>
      )}

      {screen === 'run' && (
        <div
          ref={runRef}
          tabIndex={-1}
          className={styles.run}
          role="region"
          aria-label="Pond Guardian live defense"
          data-surface="pond-guardian"
        >
          <div className={styles.runHeader}>
            <div>
              <span className={styles.missionCode}>DEFENSE LOOP / LIVE</span>
              <strong>KEEP THE FROG ALIVE</strong>
            </div>
            <span className={styles.phaseBeacon} data-phase={hud.phase}>
              <span className={styles.missionDot} aria-hidden="true" />
              PHASE {hud.phase} / 3
            </span>
          </div>
          <div className={styles.stageWrap}>
            <div className={styles.hud} aria-label="Game status">
              <div className={styles.hudBrand}>
                <strong>PG//90</strong>
                <span>LIVE DEFENSE</span>
              </div>
              <div className={styles.hudStats}>
                <div className={styles.hudStat + ' ' + styles.hudStatFrog}>
                  <div className={styles.hudStatTop}>
                    <span className={styles.hudLabel}>Frog</span>
                    <strong>
                      {hud.frogHealth}/{hud.frogMaxHealth}
                    </strong>
                  </div>
                  <div
                    className={styles.meter}
                    role="progressbar"
                    aria-label="Frog health"
                    aria-valuemin={0}
                    aria-valuemax={hud.frogMaxHealth}
                    aria-valuenow={hud.frogHealth}
                    aria-valuetext={`${hud.frogHealth} of ${hud.frogMaxHealth} health`}
                  >
                    <span
                      aria-hidden="true"
                      style={{ width: `${(hud.frogHealth / hud.frogMaxHealth) * 100}%` }}
                    />
                  </div>
                </div>
                <div className={styles.hudStat}>
                  <div className={styles.hudStatTop}>
                    <span className={styles.hudLabel}>Guard</span>
                    <strong>
                      {hud.playerHealth}/{hud.playerMaxHealth}
                    </strong>
                  </div>
                  <div
                    className={styles.pips}
                    role="img"
                    aria-label={`Guard health ${hud.playerHealth} of ${hud.playerMaxHealth}`}
                  >
                    {Array.from({ length: hud.playerMaxHealth }, (_, index) => (
                      <span key={index} className={index < hud.playerHealth ? styles.pipOn : ''} />
                    ))}
                  </div>
                </div>
                <div className={styles.hudStat + ' ' + styles.hudStatCompact}>
                  <span className={styles.hudLabel}>Time</span>
                  <strong className={hud.timeLeft <= 10 ? styles.hudDanger : undefined}>
                    {hud.timeLeft}s
                  </strong>
                </div>
                <div className={styles.hudStat + ' ' + styles.hudStatCompact}>
                  <span className={styles.hudLabel}>Score</span>
                  <strong>{hud.score}</strong>
                </div>
                <div className={styles.hudStat + ' ' + styles.hudStatCompact}>
                  <span className={styles.hudLabel}>Kills</span>
                  <strong>{hud.kills}</strong>
                </div>
              </div>
              <button
                type="button"
                className={styles.pauseButton}
                aria-label="Pause game"
                onClick={() => setPaused(true)}
              >
                Pause
              </button>
            </div>
            <div className={styles.phaseBar} role="group" aria-label={`Phase ${hud.phase} of 3`}>
              <div className={styles.phaseMeta}>
                <span>Phase {hud.phase}/3</span>
                <span>
                  {hud.threats} threats · {hud.projectiles} hazards
                </span>
              </div>
              <div
                className={styles.phaseTrack}
                role="progressbar"
                aria-label="Phase progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(hud.phaseProgress)}
                aria-valuetext={`${Math.round(hud.phaseProgress)} percent through phase ${hud.phase}`}
              >
                <span aria-hidden="true" style={{ width: `${hud.phaseProgress}%` }} />
              </div>
            </div>
            <PondGuardianStage
              key={runId}
              seed={seed}
              paused={paused}
              className={styles.stage}
              onHud={setHud}
              onEvent={(event) => {
                const message = eventAnnouncement(event)
                if (message) setAnnounce(message)
              }}
              onFinish={finishRun}
            />
            {paused && (
              <div
                className={styles.overlay}
                role="dialog"
                aria-modal="true"
                aria-label={confirmQuit ? 'Quit confirmation' : 'Pause menu'}
              >
                <div className={styles.pauseCard}>
                  {confirmQuit ? (
                    <>
                      <h3 ref={quitConfirmRef} tabIndex={-1}>
                        Quit this run?
                      </h3>
                      <p>Your current score and progress will be lost.</p>
                      <div className={styles.startRow}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => setConfirmQuit(false)}
                        >
                          Keep playing
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={onExit}>
                          Quit to arcade
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3>Paused</h3>
                      <p>The pond waits, but the swamp does not.</p>
                      <div className={styles.startRow}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => setPaused(false)}
                        >
                          Resume
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={startRun}>
                          Restart
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setConfirmQuit(true)}
                        >
                          Quit run
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          {announce && !paused && (
            <div className={styles.eventSignal} aria-hidden="true">
              <span className={styles.signalDot} aria-hidden="true" />
              {announce}
            </div>
          )}
          <p className={styles.help}>
            Move, aim and strike. Protect the frog; reduced-motion mode only removes cosmetic shake
            and glow.
          </p>
        </div>
      )}

      {screen === 'results' && result !== null && (
        <div
          className={styles.results + ' ' + styles.screenIn}
          role="region"
          aria-label="Pond Guardian mission results"
          data-surface="pond-guardian"
        >
          <div className={styles.resultsTopline}>
            <span className={styles.missionCode}>MISSION REPORT / PG-90</span>
            <span
              className={
                result.outcome === 'victory' ? styles.resultStampWin : styles.resultStampLost
              }
            >
              {result.outcome === 'victory' ? 'CENTER SECURED' : 'CENTER BREACHED'}
            </span>
          </div>
          <div className={styles.resultHero}>
            <p className={styles.eyebrow}>Run complete · local record</p>
            <h3
              ref={resultsRef}
              tabIndex={-1}
              className={result.outcome === 'victory' ? styles.outcomeWin : styles.outcomeLost}
            >
              {result.outcome === 'victory' ? 'The pond held.' : 'The swamp got through.'}
            </h3>
            <p className={styles.lede}>
              {result.outcome === 'victory'
                ? 'The frog is safe for another night.'
                : 'The next guardian gets a little wiser.'}
            </p>
          </div>
          <dl className={styles.resultGrid}>
            <div>
              <dt>Score</dt>
              <dd>{result.score}</dd>
            </div>
            <div>
              <dt>Kills</dt>
              <dd>{result.kills}</dd>
            </div>
            <div>
              <dt>Frog health</dt>
              <dd>
                {result.frogHealth}/{FROG_MAX_HEALTH}
              </dd>
            </div>
            <div>
              <dt>Best</dt>
              <dd>{best}</dd>
            </div>
          </dl>
          <div className={styles.startRow}>
            <button type="button" className="btn btn-primary" onClick={startRun}>
              Play again
            </button>
            <button type="button" className="btn btn-secondary" onClick={onExit}>
              Back to arcade
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
