import {
  DECK_COMPOSITION,
  DECK_SIZE,
  FIELD_WIDTH,
  FLY_TYPE_BY_ID,
  MAX_SCORE,
  OPENING_GNAT_COUNT,
  PADDLE_MAX_SPEED,
  PADDLE_Y,
  SPAWN_MARGIN,
  TIERS,
  tierForScore,
} from '../game/sim/constants'
import { buildDeck, buildPlan, buildSpawnSchedule } from '../game/sim/deck'
import { autoInput, clamp, createGame, replayGame, stepGame } from '../game/sim/sim'
import type { FlyTypeId, GameConfig, GameState, InputFrame } from '../game/sim/types'

function idle(): InputFrame {
  return { targetX: null, axis: 0 }
}

function playFullRun(
  seed: number,
  config?: Partial<GameConfig>,
): { state: GameState; inputs: InputFrame[] } {
  const state = createGame(seed, config)
  const inputs: InputFrame[] = []
  while (state.phase !== 'finished') {
    const input = autoInput(state)
    inputs.push(input)
    stepGame(state, input)
  }
  return { state, inputs }
}

describe('FRONG Catch simulation core', () => {
  describe('spawn schedule', () => {
    it('holds exactly 45 spawns from tick 60 to tick 3360', () => {
      const schedule = buildSpawnSchedule()
      expect(schedule).toHaveLength(45)
      expect(schedule[0]).toBe(60)
      expect(schedule[44]).toBe(3360)
    })

    it('is strictly increasing, so spawn order is deterministic', () => {
      const schedule = buildSpawnSchedule()
      for (let i = 1; i < schedule.length; i += 1) {
        expect(schedule[i]).toBeGreaterThan(schedule[i - 1])
      }
    })

    it('keeps every spawn within the 60-second run (last fly lands before tick 3600)', () => {
      const schedule = buildSpawnSchedule()
      // Slowest fly (speedMultiplier 1) falls ~640px at 3.5px/tick ≈ 183 ticks.
      expect(schedule[schedule.length - 1] + 183).toBeLessThan(60 * 60)
    })
  })

  describe('deck', () => {
    it('ships the exact design composition (20/10/8/5/2)', () => {
      const deck = buildDeck(7)
      expect(deck).toHaveLength(DECK_SIZE)
      const counts = new Map<FlyTypeId, number>()
      for (const type of deck) counts.set(type, (counts.get(type) ?? 0) + 1)
      for (const { type, count } of DECK_COMPOSITION) {
        expect(counts.get(type)).toBe(count)
      }
    })

    it('always opens with five gnats (constrained shuffle)', () => {
      for (const seed of [1, 2, 99999]) {
        const deck = buildDeck(seed)
        expect(deck.slice(0, OPENING_GNAT_COUNT)).toEqual(['gnat', 'gnat', 'gnat', 'gnat', 'gnat'])
      }
    })

    it('is deterministic per seed and varies across seeds', () => {
      expect(buildDeck(12345)).toEqual(buildDeck(12345))
      expect(buildDeck(1)).not.toEqual(buildDeck(2))
    })

    it('sums to the documented max score of 109', () => {
      let total = 0
      for (const { type, count } of DECK_COMPOSITION) {
        total += count * FLY_TYPE_BY_ID[type].points
      }
      expect(total).toBe(MAX_SCORE)
    })
  })

  describe('plan', () => {
    it('derives 45 fly plans from the seed with in-bounds spawn columns', () => {
      const plan = buildPlan(42)
      const schedule = buildSpawnSchedule()
      expect(plan).toHaveLength(45)
      plan.forEach((entry, index) => {
        expect(entry.spawnTick).toBe(schedule[index])
        expect(entry.baseX).toBeGreaterThanOrEqual(SPAWN_MARGIN)
        expect(entry.baseX).toBeLessThanOrEqual(FIELD_WIDTH - SPAWN_MARGIN)
        expect(entry.phase).toBeGreaterThanOrEqual(0)
        expect(entry.phase).toBeLessThan(1)
      })
    })

    it('is deterministic for a fixed seed', () => {
      expect(buildPlan(12345)).toEqual(buildPlan(12345))
    })
  })

  describe('game lifecycle', () => {
    it('starts in countdown with a centered paddle and a zeroed scoreboard', () => {
      const state = createGame(1)
      expect(state.phase).toBe('countdown')
      expect(state.tick).toBe(0)
      expect(state.paddleX).toBe(FIELD_WIDTH / 2)
      expect(state.score).toBe(0)
      expect(state.caught).toBe(0)
      expect(state.missed).toBe(0)
      expect(state.plan).toHaveLength(DECK_SIZE)
    })

    it('leaves countdown after exactly countdownTicks steps without advancing the clock', () => {
      const state = createGame(1, { countdownTicks: 3 })
      stepGame(state, idle())
      stepGame(state, idle())
      expect(state.phase).toBe('countdown')
      stepGame(state, idle())
      expect(state.phase).toBe('playing')
      expect(state.tick).toBe(0)
    })

    it('finishes at durationTicks with every spawned fly accounted for', () => {
      const state = createGame(1, { countdownTicks: 0, durationTicks: 300 })
      let guard = 0
      while (state.phase !== 'finished' && guard < 1000) {
        stepGame(state, idle())
        guard += 1
      }
      expect(state.phase).toBe('finished')
      expect(state.tick).toBe(300)
      const active = state.flies.filter((fly) => !fly.caught && !fly.missed).length
      expect(state.caught + state.missed + active).toBe(state.spawnCursor)
      // Schedule ticks 60/180/300 fall within 300 ticks; the next spawn (420) does not.
      expect(state.spawnCursor).toBe(3)
    })

    it('never allows a score above the deck maximum', () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const { state } = playFullRun(seed)
        expect(state.score).toBeLessThanOrEqual(MAX_SCORE)
      }
    })
  })

  describe('determinism & replay verification', () => {
    it('replays a recorded input log to the identical result (golden replay)', () => {
      const { state, inputs } = playFullRun(12345)
      // Golden values: recorded from this exact build; any sim change that moves
      // them is a breaking gameplay/verification change and must be deliberate.
      expect(state.score).toBe(103)
      expect(state.caught).toBe(42)
      expect(state.missed).toBe(3)

      const replayed = replayGame(12345, inputs)
      expect(replayed.score).toBe(state.score)
      expect(replayed.caught).toBe(state.caught)
      expect(replayed.missed).toBe(state.missed)
      expect(replayed.paddleX).toBe(state.paddleX)
      expect(replayed.tick).toBe(state.tick)
    })

    it('produces identical results for identical seeds and inputs', () => {
      const first = playFullRun(42)
      const second = playFullRun(42)
      expect(second.state.score).toBe(first.state.score)
      expect(second.state.caught).toBe(first.state.caught)
      expect(second.state.paddleX).toBe(first.state.paddleX)
    })

    it('lets a movement-respecting bot nearly max the run (game is winnable, not trivial)', () => {
      for (const seed of [1, 42, 12345, 999999]) {
        const { state } = playFullRun(seed)
        expect(state.caught).toBeGreaterThanOrEqual(40)
        expect(state.score).toBeGreaterThanOrEqual(100)
      }
    })
  })

  describe('mechanics', () => {
    it('catches a gnat that lands on the paddle and awards its points', () => {
      const state = createGame(1, { countdownTicks: 0 })
      stepGame(state, idle())
      state.flies.push({
        type: 'gnat',
        spawnTick: 1,
        baseX: state.paddleX,
        phase: 0,
        x: state.paddleX,
        y: PADDLE_Y - 20,
        caught: false,
        missed: false,
      })
      for (let i = 0; i < 10 && state.caught === 0; i += 1) stepGame(state, idle())
      expect(state.caught).toBe(1)
      expect(state.score).toBe(1)
      expect(state.lastEvent).toBe('catch')
    })

    it('counts a miss when a fly reaches the water far from the paddle', () => {
      const state = createGame(1, { countdownTicks: 0 })
      stepGame(state, idle())
      state.flies.push({
        type: 'gnat',
        spawnTick: 1,
        baseX: 60,
        phase: 0,
        x: 60,
        y: PADDLE_Y - 2,
        caught: false,
        missed: false,
      })
      for (let i = 0; i < 100 && state.missed === 0; i += 1) stepGame(state, idle())
      expect(state.missed).toBe(1)
      expect(state.score).toBe(0)
    })

    it('caps pointer-follow movement at the paddle max speed', () => {
      const state = createGame(1, { countdownTicks: 0 })
      const startX = state.paddleX
      stepGame(state, { targetX: startX + 500, axis: 0 })
      expect(state.paddleX - startX).toBe(PADDLE_MAX_SPEED)
    })

    it('moves the paddle with the keyboard axis and clamps it to the field', () => {
      const state = createGame(1, { countdownTicks: 0 })
      for (let i = 0; i < 200; i += 1) stepGame(state, { targetX: null, axis: 1 })
      expect(state.paddleX).toBe(FIELD_WIDTH - 96 / 2)
      for (let i = 0; i < 400; i += 1) stepGame(state, { targetX: null, axis: -1 })
      expect(state.paddleX).toBe(96 / 2)
    })

    it('lets keyboard movement drift to rest when the axis is released', () => {
      const state = createGame(1, { countdownTicks: 0 })
      for (let i = 0; i < 30; i += 1) stepGame(state, { targetX: null, axis: 1 })
      const movedX = state.paddleX
      for (let i = 0; i < 300; i += 1) stepGame(state, idle())
      expect(state.paddleX).toBeLessThan(movedX + FIELD_WIDTH / 2)
      expect(state.paddleX).toBeGreaterThanOrEqual(movedX)
    })
  })

  describe('tiers', () => {
    it('maps score bands to the six design tiers', () => {
      const cases: [number, number][] = [
        [0, 0],
        [19, 0],
        [20, 1],
        [39, 1],
        [40, 2],
        [59, 2],
        [60, 3],
        [79, 3],
        [80, 4],
        [108, 4],
        [109, 5],
      ]
      for (const [score, tier] of cases) {
        expect(tierForScore(score)).toBe(tier)
      }
    })

    it('names the top tiers after the FRONG tagline and the perfect run', () => {
      expect(TIERS[4].name).toBe('Just FRONG.')
      expect(TIERS[5].name).toBe('Not Wrong.')
      expect(TIERS[5].min).toBe(MAX_SCORE)
    })
  })

  describe('helpers', () => {
    it('clamps values into range', () => {
      expect(clamp(5, 0, 10)).toBe(5)
      expect(clamp(-5, 0, 10)).toBe(0)
      expect(clamp(15, 0, 10)).toBe(10)
    })
  })
})
