import { DECK_COMPOSITION, FIELD_WIDTH, OPENING_GNAT_COUNT, SPAWN_MARGIN } from './constants'
import { createRng } from './rng'
import type { FlyPlan, FlyTypeId } from './types'

/**
 * Spawn schedule (design doc §3.3): warm-up 5 flies every 2.0s, main 20 flies
 * every 1.4s, peak 20 flies every 0.9s; last spawn at tick 3360 (t=56s) so every
 * fly lands before the 60s clock ends. Exactly 45 entries, strictly increasing.
 */
export function buildSpawnSchedule(): number[] {
  const ticks: number[] = []
  for (let k = 0; k < 5; k += 1) ticks.push(60 + 120 * k)
  for (let k = 1; k <= 20; k += 1) ticks.push(600 + 84 * k)
  for (let k = 1; k <= 20; k += 1) ticks.push(2280 + 54 * k)
  return ticks
}

/**
 * The 45-card deck: the opening 5 spawns are always gnats (they teach the one
 * verb — move), the remaining 40 cards are uniformly shuffled with the run seed.
 */
export function buildDeck(seed: number): FlyTypeId[] {
  const opening: FlyTypeId[] = []
  for (let i = 0; i < OPENING_GNAT_COUNT; i += 1) opening.push('gnat')
  const rest: FlyTypeId[] = []
  for (const { type, count } of DECK_COMPOSITION) {
    const remaining = type === 'gnat' ? count - OPENING_GNAT_COUNT : count
    for (let i = 0; i < remaining; i += 1) rest.push(type)
  }
  const rng = createRng(seed)
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = rest[i]
    rest[i] = rest[j]
    rest[j] = tmp
  }
  return [...opening, ...rest]
}

/**
 * The full run plan: deck order + spawn ticks + per-fly spawn column and drift
 * phase, all derived from the seed at creation. No randomness is needed during
 * the run itself, which keeps replay trivially deterministic.
 */
export function buildPlan(seed: number): FlyPlan[] {
  const deck = buildDeck(seed)
  const schedule = buildSpawnSchedule()
  const rng = createRng((seed ^ 0x9e3779b9) >>> 0)
  return deck.map((type, index) => ({
    type,
    spawnTick: schedule[index],
    baseX: SPAWN_MARGIN + rng() * (FIELD_WIDTH - SPAWN_MARGIN * 2),
    phase: rng(),
  }))
}
