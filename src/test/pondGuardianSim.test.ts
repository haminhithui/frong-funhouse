import { describe, expect, it } from 'vitest'
import {
  ENEMY_SPECS,
  FROG_MAX_HEALTH,
  PROJECTILE_SPECS,
} from '../games/pond-guardian/sim/constants'
import { applyRadialDeadzone } from '../games/pond-guardian/input'
import { createGame, emptyInput, replayGame, stepGame } from '../games/pond-guardian/sim/sim'
import type { Enemy, InputFrame, Projectile, Vec2 } from '../games/pond-guardian/sim/types'

function enemyAt(type: Enemy['type'], position: Vec2): Enemy {
  const spec = ENEMY_SPECS[type]
  return {
    id: 1,
    type,
    state: 'approach',
    target: spec.target,
    position: { ...position },
    velocity: { x: 0, y: 0 },
    health: spec.maxHealth,
    maxHealth: spec.maxHealth,
    stateTicks: 0,
    attackApplied: false,
    attackCooldownTicks: 0,
    hitFlashTicks: 0,
    knockback: { x: 0, y: 0 },
    lastHitAttackId: -1,
    steerPhase: 0,
  }
}

function idle(): InputFrame {
  return emptyInput()
}

describe('Pond Guardian simulation', () => {
  it('uses a radial deadzone for analog sticks', () => {
    expect(applyRadialDeadzone({ x: 0.1, y: 0 })).toEqual({ x: 0, y: 0 })
    expect(applyRadialDeadzone({ x: 1, y: 0 })).toEqual({ x: 1, y: 0 })
  })

  it('spawns enemies on the playable arena boundary', () => {
    const state = createGame(99, {
      durationTicks: 120,
      spawnRatesPerSecond: [60, 60, 60],
    })
    state.spawnAccumulator = 1

    stepGame(state, idle())

    const enemy = state.enemies[0]
    expect(enemy.position.x).toBeGreaterThanOrEqual(22)
    expect(enemy.position.x).toBeLessThanOrEqual(618)
    expect(enemy.position.y).toBeGreaterThanOrEqual(22)
    expect(enemy.position.y).toBeLessThanOrEqual(458)
  })

  it('replays the same seed and input log deterministically', () => {
    const config = {
      durationTicks: 120,
      phaseDurationTicks: 40,
      spawnRatesPerSecond: [0, 0, 0] as const,
    }
    const inputs = Array.from({ length: 120 }, idle)
    const first = replayGame(1234, inputs, config)
    const second = replayGame(1234, inputs, config)

    expect(second).toEqual(first)
    expect(first.status).toBe('won')
    expect(first.tick).toBe(120)
  })

  it('fires mixed ranged patterns and curves spores toward a moving target', () => {
    const state = createGame(55, { durationTicks: 240, spawnRatesPerSecond: [0, 0, 0] })
    const caster = enemyAt('sporecaster', {
      x: state.player.position.x + 180,
      y: state.player.position.y,
    })
    state.enemies.push(caster)

    for (let i = 0; i < 28; i += 1) stepGame(state, idle())

    const types = new Set(state.projectiles.map((projectile) => projectile.type))
    expect(state.projectiles).toHaveLength(3)
    expect(types).toEqual(new Set(['spore', 'needle']))

    const spore = state.projectiles.find((projectile) => projectile.type === 'spore')
    expect(spore).toBeDefined()
    const previousVelocity = { ...spore!.velocity }
    state.player.position.y -= 90
    stepGame(state, idle())
    expect(spore!.velocity.y).not.toBe(previousVelocity.y)
  })

  it('expands brute shockwaves and lets the axe clear hazards', () => {
    const state = createGame(56, { durationTicks: 240, spawnRatesPerSecond: [0, 0, 0] })
    const brute = enemyAt('brute', { x: state.frog.position.x - 70, y: state.frog.position.y })
    state.enemies.push(brute)

    for (let i = 0; i < 55; i += 1) stepGame(state, idle())
    expect(state.frog.health).toBeLessThan(FROG_MAX_HEALTH)

    const hazard: Projectile = {
      id: 99,
      type: 'needle',
      position: { x: state.player.position.x + 40, y: state.player.position.y },
      velocity: { x: PROJECTILE_SPECS.needle.speed, y: 0 },
      target: 'player',
      age: 0,
      maxAge: PROJECTILE_SPECS.needle.lifetimeTicks,
      radius: PROJECTILE_SPECS.needle.radius,
      travelRadius: 0,
      damage: PROJECTILE_SPECS.needle.damage,
      turnRate: PROJECTILE_SPECS.needle.turnRate,
      lastHitAttackId: -1,
    }
    state.projectiles.push(hazard)
    stepGame(state, { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, attackPressed: true })
    expect(state.projectiles.some((projectile) => projectile.id === 99)).toBe(false)
  })

  it('advances through the three 30-second phases and wins at the timer', () => {
    const state = createGame(42, {
      durationTicks: 180,
      phaseDurationTicks: 60,
      spawnRatesPerSecond: [0, 0, 0],
    })
    for (let i = 0; i < 60; i += 1) stepGame(state, idle())
    expect(state.phase).toBe(2)
    for (let i = 0; i < 60; i += 1) stepGame(state, idle())
    expect(state.phase).toBe(3)
    for (let i = 0; i < 60; i += 1) stepGame(state, idle())
    expect(state.status).toBe('won')
  })

  it('damages a target at most once per attack swing', () => {
    const state = createGame(7, { durationTicks: 180, spawnRatesPerSecond: [0, 0, 0] })
    const target = enemyAt('brute', { x: state.player.position.x + 40, y: state.player.position.y })
    state.enemies.push(target)

    stepGame(state, { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, attackPressed: true })
    expect(state.enemies[0].health).toBe(3)
    for (let i = 0; i < 5; i += 1) stepGame(state, idle())
    expect(state.enemies[0].health).toBe(3)
  })

  it('loses when the frog reaches zero health', () => {
    const state = createGame(8, { durationTicks: 180, spawnRatesPerSecond: [0, 0, 0] })
    state.frog.health = 1
    const attacker = enemyAt('mireling', {
      x: state.frog.position.x - 40,
      y: state.frog.position.y,
    })
    attacker.state = 'attack'
    attacker.stateTicks = 1
    state.enemies.push(attacker)

    stepGame(state, idle())
    expect(state.status).toBe('lost')
    expect(state.lastEvent?.kind).toBe('defeat')
  })

  it('calculates the local score from kills, frog health, and victory bonus', () => {
    const state = createGame(9, { durationTicks: 60, spawnRatesPerSecond: [0, 0, 0] })
    state.kills = 3
    state.frog.health = 5
    stepGame(state, idle())
    expect(state.score).toBe(155)
  })
})
