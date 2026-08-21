export type FlyTypeId = 'gnat' | 'midge' | 'drifter' | 'firefly' | 'queen'

export type DriftKind = 'none' | 'sine' | 'erratic'

export interface FlyTypeSpec {
  id: FlyTypeId
  points: number
  speedMultiplier: number
  radius: number
  drift: DriftKind
  driftAmplitude: number
  driftPeriodTicks: number
}

/** Static per-fly plan entry, fully derived from the run seed at creation time. */
export interface FlyPlan {
  type: FlyTypeId
  spawnTick: number
  baseX: number
  phase: number
}

export interface Fly extends FlyPlan {
  x: number
  y: number
  caught: boolean
  missed: boolean
}

export type GamePhase = 'countdown' | 'playing' | 'finished'

/** One tick of player input. Exactly one of targetX / axis drives the paddle. */
export interface InputFrame {
  /** Pointer target in logical field pixels, or null when no pointer is active. */
  targetX: number | null
  /** Keyboard axis: -1 left, 0 none, 1 right. */
  axis: -1 | 0 | 1
}

export interface GameConfig {
  durationTicks: number
  countdownTicks: number
  fieldWidth: number
  fieldHeight: number
}

export interface GameState {
  seed: number
  config: GameConfig
  /** Ticks elapsed in the playing phase (0..durationTicks). */
  tick: number
  phase: GamePhase
  countdownLeft: number
  plan: FlyPlan[]
  flies: Fly[]
  spawnCursor: number
  paddleX: number
  paddleV: number
  score: number
  caught: number
  missed: number
  lastEvent: 'none' | 'catch' | 'miss'
  lastCaughtType: FlyTypeId | null
  /**
   * Cosmetic event bookkeeping for the renderer: the tick and position of the
   * most recent catch/miss. Presentation-only — never affects scoring or the
   * replay-verification result.
   */
  lastEventTick: number
  lastEventX: number
  lastEventY: number
}
