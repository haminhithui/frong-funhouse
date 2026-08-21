import {
  BASE_FALL_SPEED,
  DEFAULT_COUNTDOWN_TICKS,
  DEFAULT_DURATION_TICKS,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  FLY_TYPE_BY_ID,
  PADDLE_ACCEL,
  PADDLE_FRICTION,
  PADDLE_HEIGHT,
  PADDLE_MAX_SPEED,
  PADDLE_WIDTH,
  PADDLE_Y,
} from './constants'
import { buildPlan } from './deck'
import { dsin } from './dsin'
import type { Fly, GameConfig, GameState, InputFrame } from './types'

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function createGame(seed: number, config: Partial<GameConfig> = {}): GameState {
  const full: GameConfig = {
    durationTicks: config.durationTicks ?? DEFAULT_DURATION_TICKS,
    countdownTicks: config.countdownTicks ?? DEFAULT_COUNTDOWN_TICKS,
    fieldWidth: config.fieldWidth ?? FIELD_WIDTH,
    fieldHeight: config.fieldHeight ?? FIELD_HEIGHT,
  }
  return {
    seed: seed >>> 0,
    config: full,
    tick: 0,
    phase: full.countdownTicks > 0 ? 'countdown' : 'playing',
    countdownLeft: full.countdownTicks,
    plan: buildPlan(seed >>> 0),
    flies: [],
    spawnCursor: 0,
    paddleX: full.fieldWidth / 2,
    paddleV: 0,
    score: 0,
    caught: 0,
    missed: 0,
    lastEvent: 'none',
    lastCaughtType: null,
    lastEventTick: -1,
    lastEventX: full.fieldWidth / 2,
    lastEventY: 0,
  }
}

/** Advance the simulation exactly one fixed tick. Mutates `state`. */
export function stepGame(state: GameState, input: InputFrame): void {
  state.lastEvent = 'none'

  if (state.phase === 'countdown') {
    state.countdownLeft -= 1
    if (state.countdownLeft <= 0) state.phase = 'playing'
    return
  }
  if (state.phase !== 'playing') return

  state.tick += 1

  // Spawn any flies whose tick has arrived.
  while (
    state.spawnCursor < state.plan.length &&
    state.plan[state.spawnCursor].spawnTick <= state.tick
  ) {
    const plan = state.plan[state.spawnCursor]
    state.flies.push({ ...plan, x: plan.baseX, y: -20, caught: false, missed: false })
    state.spawnCursor += 1
  }

  // Paddle: pointer-follow with max-speed smoothing, or keyboard acceleration.
  const half = PADDLE_WIDTH / 2
  const minX = half
  const maxX = state.config.fieldWidth - half
  if (input.targetX !== null) {
    const target = clamp(input.targetX, minX, maxX)
    const move = clamp(target - state.paddleX, -PADDLE_MAX_SPEED, PADDLE_MAX_SPEED)
    state.paddleX += move
    state.paddleV = move
  } else if (input.axis !== 0) {
    state.paddleV = clamp(
      state.paddleV + input.axis * PADDLE_ACCEL,
      -PADDLE_MAX_SPEED,
      PADDLE_MAX_SPEED,
    )
    state.paddleX = clamp(state.paddleX + state.paddleV, minX, maxX)
  } else {
    state.paddleV *= PADDLE_FRICTION
    if (Math.abs(state.paddleV) < 0.05) state.paddleV = 0
    state.paddleX = clamp(state.paddleX + state.paddleV, minX, maxX)
  }

  // Flies: fall, drift, then resolve catch / miss.
  const paddleTop = PADDLE_Y
  for (const fly of state.flies) {
    if (fly.caught || fly.missed) continue
    const spec = FLY_TYPE_BY_ID[fly.type]
    const age = state.tick - fly.spawnTick
    fly.y += BASE_FALL_SPEED * spec.speedMultiplier

    let x = fly.baseX
    if (spec.drift === 'sine') {
      x += spec.driftAmplitude * dsin(fly.phase + age / spec.driftPeriodTicks)
    } else if (spec.drift === 'erratic') {
      x +=
        spec.driftAmplitude *
        (0.6 * dsin(fly.phase + age / spec.driftPeriodTicks) +
          0.4 * dsin(fly.phase * 2 + age / (spec.driftPeriodTicks * 0.37)))
    }
    fly.x = clamp(x, spec.radius, state.config.fieldWidth - spec.radius)

    const withinX = Math.abs(fly.x - state.paddleX) <= half + spec.radius * 0.5
    const withinY =
      fly.y + spec.radius >= paddleTop && fly.y - spec.radius <= paddleTop + PADDLE_HEIGHT + 8
    if (withinX && withinY) {
      fly.caught = true
      state.caught += 1
      state.score += spec.points
      state.lastEvent = 'catch'
      state.lastCaughtType = fly.type
      state.lastEventTick = state.tick
      state.lastEventX = fly.x
      state.lastEventY = fly.y
      continue
    }
    if (fly.y - spec.radius > state.config.fieldHeight) {
      fly.missed = true
      state.missed += 1
      state.lastEvent = 'miss'
      state.lastEventTick = state.tick
      state.lastEventX = fly.x
      state.lastEventY = fly.y
    }
  }

  if (state.tick >= state.config.durationTicks) {
    state.phase = 'finished'
  }
}

/** Replay a recorded input log from a seed. This is the verification primitive. */
export function replayGame(
  seed: number,
  inputs: InputFrame[],
  config?: Partial<GameConfig>,
): GameState {
  const state = createGame(seed, config)
  for (const input of inputs) stepGame(state, input)
  return state
}

/**
 * Greedy bot input: steer toward the active fly nearest the catch line.
 * Respects the same max-speed movement as a human pointer. Used by tests and
 * soak tooling to prove runs are winnable without teleporting.
 */
export function autoInput(state: GameState): InputFrame {
  let target: Fly | null = null
  for (const fly of state.flies) {
    if (fly.caught || fly.missed || fly.y > PADDLE_Y) continue
    if (!target || fly.y > target.y) target = fly
  }
  return { targetX: target ? target.x : state.config.fieldWidth / 2, axis: 0 }
}
