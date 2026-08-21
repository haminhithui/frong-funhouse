import { createHash } from 'node:crypto'
import { createGame, stepGame, autoInput, replayGame } from '../../../src/game/sim/sim'
import { DECK_SIZE, FIELD_WIDTH, MAX_SCORE } from '../../../src/game/sim/constants'
import type { GameState, InputFrame } from '../../../src/game/sim/types'
import type { ServerConfig } from './config'

/**
 * Canonical input-log hash. MUST match the client-side canonicalization in
 * src/paid/log.ts exactly - the hash is the run's fingerprint and is engraved
 * in the on-chain attestation.
 */
export function hashInputLog(log: InputFrame[]): string {
  const canonical = JSON.stringify(log.map((frame) => [frame.targetX, frame.axis]))
  return createHash('sha256').update(canonical).digest('hex')
}

export type VerifyResult =
  { ok: true; state: GameState; inputLogHash: string } | { ok: false; reason: string }

/**
 * Plausibility constants (D4/D6). Paid attempts stay UNLIMITED - these
 * checks reject only impossible or automated inputs, never a paid attempt.
 * A deterministic sim cannot prove a human played; residual bot economics
 * are disclosed in the paid UI (automated solver-style inputs are rejected).
 */
/** Max axis sign-flips per playing tick (0.5 = 30/s). Keyboard repeat is far
 * slower; a per-tick alternating axis is not humanly possible. */
const MAX_AXIS_FLIPS_PER_TICK = 0.5
/** A human pointer cannot match the greedy solver's exact target within
 * 0.5px on >=98% of playing ticks. */
const SOLVER_MATCH_RATIO = 0.98
/** Minimum comparable ticks before the solver check applies (short dev/test
 * runs below this are exempt). */
const SOLVER_MIN_SAMPLE = 100

/** A frame is exactly { targetX, axis } - no extra fields survive. */
function isPlainFrame(frame: unknown): frame is InputFrame {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return false
  const keys = Object.keys(frame as object)
  return keys.length === 2 && 'targetX' in (frame as object) && 'axis' in (frame as object)
}

/**
 * Replays the submitted input log against the session seed with the exact
 * shared sim build. The server derives score/caught/missed itself - the
 * client's claimed numbers are never trusted.
 *
 * Rejection order (stable reasons):
 *   length -> frame shape -> axis/velocity -> hash -> solver signature ->
 *   replay -> finish line -> deck invariants.
 */
export function verifyRun(
  config: ServerConfig,
  seed: number,
  inputLog: InputFrame[],
  claimedHash: string,
): VerifyResult {
  const expectedTicks = config.countdownTicks + config.durationTicks
  if (!Array.isArray(inputLog) || inputLog.length !== expectedTicks) {
    return { ok: false, reason: 'input log length does not match the session' }
  }
  for (const frame of inputLog) {
    if (!isPlainFrame(frame)) {
      return { ok: false, reason: 'malformed input frame' }
    }
    if (frame.axis !== -1 && frame.axis !== 0 && frame.axis !== 1) {
      return { ok: false, reason: 'invalid input axis' }
    }
    if (frame.targetX !== null) {
      if (typeof frame.targetX !== 'number' || !Number.isFinite(frame.targetX)) {
        return { ok: false, reason: 'invalid input targetX' }
      }
      if (frame.targetX < 0 || frame.targetX > FIELD_WIDTH) {
        return { ok: false, reason: 'input targetX out of field bounds' }
      }
    }
  }
  if (hashInputLog(inputLog) !== claimedHash) {
    return { ok: false, reason: 'input log hash mismatch' }
  }

  // Velocity: keyboard axis sign-flip rate across PLAYING ticks only
  // (countdown inputs are ignored by the sim and may be mashed freely).
  const playingTicks = inputLog.length - config.countdownTicks
  let flips = 0
  let lastSign = 0
  for (const frame of inputLog.slice(config.countdownTicks)) {
    if (frame.axis !== 0) {
      if (lastSign !== 0 && frame.axis !== lastSign) flips += 1
      lastSign = frame.axis
    }
  }
  if (flips > playingTicks * MAX_AXIS_FLIPS_PER_TICK) {
    return { ok: false, reason: 'input axis flip rate exceeds human limits' }
  }

  // Solver signature: replay the greedy solution for the seed and compare
  // pointer targets. Exact tracking on nearly every tick is automation.
  const solverState = createGame(seed, {
    countdownTicks: config.countdownTicks,
    durationTicks: config.durationTicks,
  })
  let comparable = 0
  let matched = 0
  for (const frame of inputLog) {
    const solver = autoInput(solverState)
    stepGame(solverState, solver)
    if (frame.targetX !== null && solver.targetX !== null) {
      comparable += 1
      if (Math.abs(frame.targetX - solver.targetX) <= 0.5) matched += 1
    }
  }
  if (comparable >= SOLVER_MIN_SAMPLE && matched / comparable >= SOLVER_MATCH_RATIO) {
    return { ok: false, reason: 'input matches automated solver signature' }
  }

  const state = replayGame(seed, inputLog, {
    countdownTicks: config.countdownTicks,
    durationTicks: config.durationTicks,
  })
  if (state.phase !== 'finished') return { ok: false, reason: 'run did not reach the finish line' }
  if (state.score > MAX_SCORE) return { ok: false, reason: 'score exceeds the deck maximum' }
  if (state.caught > DECK_SIZE) return { ok: false, reason: 'caught flies exceed the deck size' }
  return { ok: true, state, inputLogHash: claimedHash }
}
