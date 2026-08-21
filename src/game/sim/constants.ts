import type { FlyTypeId, FlyTypeSpec } from './types'

/** Fixed timestep: the simulation advances exactly 60 times per second. */
export const TICKS_PER_SECOND = 60
/** 60 seconds of play (design doc §3.3). */
export const DEFAULT_DURATION_TICKS = 60 * TICKS_PER_SECOND
export const DEFAULT_COUNTDOWN_TICKS = 3 * TICKS_PER_SECOND

/** Logical playfield size in pixels; the renderer scales to fit. */
export const FIELD_WIDTH = 480
export const FIELD_HEIGHT = 640

export const PADDLE_WIDTH = 96
export const PADDLE_HEIGHT = 20
/** Vertical position of the paddle's catch plane (px from field top). */
export const PADDLE_Y = FIELD_HEIGHT - 70
export const PADDLE_MAX_SPEED = 12
export const PADDLE_ACCEL = 1.5
export const PADDLE_FRICTION = 0.8

/** Fall speed of a 1.0x fly in px/tick (~3.05s top to bottom). */
export const BASE_FALL_SPEED = 3.5

/** Margin from the side walls for fly spawn columns. */
export const SPAWN_MARGIN = 28

export const FLY_TYPES: readonly FlyTypeSpec[] = [
  {
    id: 'gnat',
    points: 1,
    speedMultiplier: 1,
    radius: 14,
    drift: 'none',
    driftAmplitude: 0,
    driftPeriodTicks: 120,
  },
  {
    id: 'midge',
    points: 2,
    speedMultiplier: 1.5,
    radius: 10,
    drift: 'none',
    driftAmplitude: 0,
    driftPeriodTicks: 120,
  },
  {
    id: 'drifter',
    points: 3,
    speedMultiplier: 1,
    radius: 14,
    drift: 'sine',
    driftAmplitude: 56,
    driftPeriodTicks: 150,
  },
  {
    id: 'firefly',
    points: 5,
    speedMultiplier: 1.3,
    radius: 16,
    drift: 'sine',
    driftAmplitude: 28,
    driftPeriodTicks: 96,
  },
  {
    id: 'queen',
    points: 10,
    speedMultiplier: 1.2,
    radius: 15,
    drift: 'erratic',
    driftAmplitude: 44,
    driftPeriodTicks: 66,
  },
]

export const FLY_TYPE_BY_ID: Record<FlyTypeId, FlyTypeSpec> = {
  gnat: FLY_TYPES[0],
  midge: FLY_TYPES[1],
  drifter: FLY_TYPES[2],
  firefly: FLY_TYPES[3],
  queen: FLY_TYPES[4],
}

/** Fixed 45-fly deck composition (design doc §3.4). */
export const DECK_COMPOSITION: readonly { type: FlyTypeId; count: number }[] = [
  { type: 'gnat', count: 20 },
  { type: 'midge', count: 10 },
  { type: 'drifter', count: 8 },
  { type: 'firefly', count: 5 },
  { type: 'queen', count: 2 },
]

export const DECK_SIZE = 45
/** The opening spawns are always gnats — the constrained shuffle (design §3.6). */
export const OPENING_GNAT_COUNT = 5
/** 20·1 + 10·2 + 8·3 + 5·5 + 2·10. */
export const MAX_SCORE = 109

export interface TierSpec {
  name: string
  min: number
}

/** Score-banded reward tiers (design doc §3.5). */
export const TIERS: readonly TierSpec[] = [
  { name: 'Tadpole', min: 0 },
  { name: 'Pond Hopper', min: 20 },
  { name: 'Fly Snatcher', min: 40 },
  { name: 'Lily Legend', min: 60 },
  { name: 'Just FRONG.', min: 80 },
  { name: 'Not Wrong.', min: 109 },
]

export function tierForScore(score: number): number {
  let tier = 0
  for (let i = 0; i < TIERS.length; i += 1) {
    if (score >= TIERS[i].min) tier = i
  }
  return tier
}
