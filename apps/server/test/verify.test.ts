import { describe, expect, it } from 'vitest'
import { createGame, stepGame, autoInput, replayGame } from '../../../src/game/sim/sim'
import type { InputFrame } from '../../../src/game/sim/types'
import { hashInputLog, verifyRun } from '../src/verify'
import { testConfig } from './config'

function playFullLog(seed: number, countdownTicks: number, durationTicks: number): InputFrame[] {
  const state = createGame(seed, { countdownTicks, durationTicks })
  const inputs: InputFrame[] = []
  while (state.phase !== 'finished') {
    const input = autoInput(state)
    inputs.push(input)
    stepGame(state, input)
  }
  return inputs
}

/**
 * Normal pointer/keyboard log: the pointer is moved in coarse human-scale
 * gestures and held between movements. It is deliberately independent of the
 * active fly positions so it cannot accidentally encode the solver trajectory.
 */
function playNormalLog(seed: number, countdownTicks: number, durationTicks: number): InputFrame[] {
  const state = createGame(seed, { countdownTicks, durationTicks })
  const inputs: InputFrame[] = []
  while (state.phase !== 'finished') {
    const tick = state.tick
    let input: InputFrame
    if (tick > 0 && tick % 53 === 0) {
      input = { targetX: null, axis: 1 }
    } else if (tick > 0 && tick % 89 === 0) {
      input = { targetX: null, axis: -1 }
    } else {
      const gesture = Math.floor(Math.max(tick, 0) / 11)
      const targetX = 72 + ((gesture * 137 + seed) % 336)
      input = { targetX, axis: 0 }
    }
    inputs.push(input)
    stepGame(state, input)
  }
  return inputs
}

describe('replay verification', () => {
  const config = testConfig()

  it('replays the golden seed to the frozen values (server shares the exact sim)', () => {
    const state = createGame(12345)
    const inputs: InputFrame[] = []
    while (state.phase !== 'finished') {
      const input = autoInput(state)
      inputs.push(input)
      stepGame(state, input)
    }
    expect(state.score).toBe(103)
    expect(state.caught).toBe(42)
    expect(state.missed).toBe(3)
    expect(replayGame(12345, inputs).score).toBe(103)
  })

  it('accepts a short honest log below the solver-sample threshold', () => {
    const seed = 999
    const log = playFullLog(seed, config.countdownTicks, config.durationTicks)
    const hash = hashInputLog(log)
    const result = verifyRun(config, seed, log, hash)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.state.score).toBeLessThanOrEqual(109)
      expect(result.inputLogHash).toBe(hash)
    }
  })

  it('rejects a tampered frame (hash mismatch)', () => {
    const seed = 999
    const log = playFullLog(seed, config.countdownTicks, config.durationTicks)
    const hash = hashInputLog(log)
    const tampered = log.map((frame, index) =>
      index === 5 ? { targetX: (frame.targetX ?? 0) + 1, axis: frame.axis } : frame,
    )
    const result = verifyRun(config, seed, tampered, hash)
    expect(result).toEqual({ ok: false, reason: 'input log hash mismatch' })
  })

  it('rejects a wrong log length', () => {
    const seed = 999
    const log = playFullLog(seed, config.countdownTicks, config.durationTicks)
    const result = verifyRun(config, seed, log.slice(0, -1), hashInputLog(log.slice(0, -1)))
    expect(result).toEqual({ ok: false, reason: 'input log length does not match the session' })
  })

  it('rejects an out-of-bounds targetX', () => {
    const seed = 999
    const log = playFullLog(seed, config.countdownTicks, config.durationTicks)
    log[3] = { targetX: 10_000, axis: 0 }
    const result = verifyRun(config, seed, log, hashInputLog(log))
    expect(result).toEqual({ ok: false, reason: 'input targetX out of field bounds' })
  })

  it('rejects an invalid axis', () => {
    const seed = 999
    const log = playFullLog(seed, config.countdownTicks, config.durationTicks)
    log[3] = { targetX: null, axis: 2 as -1 | 0 | 1 }
    const result = verifyRun(config, seed, log, hashInputLog(log))
    expect(result).toEqual({ ok: false, reason: 'invalid input axis' })
  })

  it('rejects a forged hash over a valid log', () => {
    const seed = 999
    const log = playFullLog(seed, config.countdownTicks, config.durationTicks)
    const result = verifyRun(config, seed, log, '0'.repeat(64))
    expect(result).toEqual({ ok: false, reason: 'input log hash mismatch' })
  })

  it('rejects a frame carrying unknown fields', () => {
    const seed = 999
    const log = playFullLog(seed, config.countdownTicks, config.durationTicks)
    log[3] = { targetX: 0, axis: 0, extra: 1 } as unknown as InputFrame
    const result = verifyRun(config, seed, log, hashInputLog(log))
    expect(result).toEqual({ ok: false, reason: 'malformed input frame' })
  })

  it('rejects an alternating-axis storm (impossible keyboard velocity)', () => {
    const seed = 999
    const log = Array.from({ length: config.countdownTicks + config.durationTicks }, (_, i) => ({
      targetX: null,
      axis: (i % 2 === 0 ? 1 : -1) as -1 | 1,
    }))
    const result = verifyRun(config, seed, log, hashInputLog(log))
    expect(result).toEqual({ ok: false, reason: 'input axis flip rate exceeds human limits' })
  })

  it('rejects a log that exactly tracks the greedy solver', () => {
    const longConfig = testConfig({ countdownTicks: 1, durationTicks: 200 })
    const seed = 4242
    const log = playFullLog(seed, longConfig.countdownTicks, longConfig.durationTicks)
    const result = verifyRun(longConfig, seed, log, hashInputLog(log))
    expect(result).toEqual({ ok: false, reason: 'input matches automated solver signature' })
  })

  it('accepts normal pointer and keyboard play at production-like length', () => {
    const longConfig = testConfig({ countdownTicks: 1, durationTicks: 200 })
    const seed = 4242
    const log = playNormalLog(seed, longConfig.countdownTicks, longConfig.durationTicks)
    const hash = hashInputLog(log)
    const result = verifyRun(longConfig, seed, log, hash)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.state.score).toBeLessThanOrEqual(109)
  })

  it('rejects a greedy solver with small deterministic jitter', () => {
    const longConfig = testConfig({ countdownTicks: 1, durationTicks: 200 })
    const seed = 4242
    const state = createGame(seed, {
      countdownTicks: longConfig.countdownTicks,
      durationTicks: longConfig.durationTicks,
    })
    const log: InputFrame[] = []
    let jitterState = 1
    while (state.phase !== 'finished') {
      jitterState = (jitterState * 1103515245 + 12345) % 2147483648
      const jitter = ((jitterState % 17) - 8) * 0.6
      const solver = autoInput(state)
      const tick = state.tick
      const input =
        tick > 0 && tick % 40 === 0
          ? { targetX: null, axis: (tick % 80 === 0 ? -1 : 1) as -1 | 1 }
          : { targetX: (solver.targetX ?? 240) + jitter, axis: 0 as const }
      log.push(input)
      stepGame(state, log[log.length - 1])
    }

    const result = verifyRun(longConfig, seed, log, hashInputLog(log))
    expect(result).toEqual({
      ok: false,
      reason: 'input matches automated solver with low-jitter pointer cadence',
    })
  })

  it('accepts a constant idle log (entropy floor intentionally not enforced)', () => {
    // A player who parks the paddle is legitimate; a pure entropy floor would
    // false-positive idle runs, so this stays accepted and documented.
    const seed = 999
    const log = Array.from({ length: config.countdownTicks + config.durationTicks }, () => ({
      targetX: 240,
      axis: 0 as const,
    }))
    const result = verifyRun(config, seed, log, hashInputLog(log))
    expect(result.ok).toBe(true)
  })
})
