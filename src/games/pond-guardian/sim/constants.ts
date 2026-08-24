import type { EnemyTarget } from './types'

export const TICKS_PER_SECOND = 60
export const FIELD_WIDTH = 640
export const FIELD_HEIGHT = 480
export const DEFAULT_DURATION_TICKS = 90 * TICKS_PER_SECOND
export const DEFAULT_PHASE_DURATION_TICKS = 30 * TICKS_PER_SECOND

export const PLAYER_MAX_HEALTH = 3
export const PLAYER_SPEED = 170
export const PLAYER_RADIUS = 16
export const PLAYER_START = { x: 146, y: 354 } as const

export const FROG_MAX_HEALTH = 8
export const FROG_RADIUS = 28
export const FROG_POSITION = { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2 } as const

export const ATTACK_RANGE = 60
export const ATTACK_HALF_ANGLE = Math.PI / 3
export const ATTACK_DAMAGE = 1
export const ATTACK_TICKS = 10
export const ATTACK_COOLDOWN_TICKS = 21
export const ATTACK_KNOCKBACK = 150

export const MAX_ENEMIES = 24
export const INPUT_DEADZONE = 0.2
export const ARENA_MARGIN = 22
export const SEPARATION_DISTANCE = 34
export const SEPARATION_FORCE = 22

export type EnemyType = 'mireling' | 'leaper' | 'brute' | 'sporecaster'

export type AttackStyle = 'melee' | 'dash' | 'shockwave' | 'ranged'
export type ProjectileType = 'spore' | 'needle' | 'shockwave'

export interface ProjectileSpec {
  speed: number
  damage: number
  radius: number
  lifetimeTicks: number
  turnRate: number
}

export interface EnemySpec {
  radius: number
  maxHealth: number
  speed: number
  target: EnemyTarget
  attackStyle: AttackStyle
  windupTicks: number
  attackTicks: number
  attackRange: number
  attackCooldownTicks: number
  damage: number
  dashSpeed?: number
  projectileType?: ProjectileType
  projectileCount?: number
  projectileSpread?: number
}

export const ENEMY_SPECS: Record<EnemyType, EnemySpec> = {
  mireling: {
    radius: 15,
    maxHealth: 1,
    speed: 46,
    target: 'frog',
    attackStyle: 'melee',
    windupTicks: 24,
    attackTicks: 12,
    attackRange: 38,
    attackCooldownTicks: 42,
    damage: 1,
  },
  leaper: {
    radius: 13,
    maxHealth: 1,
    speed: 88,
    target: 'player',
    attackStyle: 'dash',
    windupTicks: 18,
    attackTicks: 10,
    attackRange: 32,
    attackCooldownTicks: 48,
    damage: 1,
    dashSpeed: 250,
  },
  brute: {
    radius: 23,
    maxHealth: 4,
    speed: 31,
    target: 'frog',
    attackStyle: 'shockwave',
    windupTicks: 36,
    attackTicks: 14,
    attackRange: 82,
    attackCooldownTicks: 54,
    damage: 2,
    projectileType: 'shockwave',
    projectileCount: 1,
    projectileSpread: 0,
  },
  sporecaster: {
    radius: 17,
    maxHealth: 2,
    speed: 52,
    target: 'player',
    attackStyle: 'ranged',
    windupTicks: 26,
    attackTicks: 8,
    attackRange: 250,
    attackCooldownTicks: 56,
    damage: 1,
    projectileType: 'spore',
    projectileCount: 3,
    projectileSpread: 0.22,
  },
}

export const PROJECTILE_SPECS: Record<ProjectileType, ProjectileSpec> = {
  spore: {
    speed: 116,
    damage: 1,
    radius: 7,
    lifetimeTicks: 240,
    turnRate: 0.045,
  },
  needle: {
    speed: 214,
    damage: 1,
    radius: 4,
    lifetimeTicks: 120,
    turnRate: 0,
  },
  shockwave: {
    speed: 132,
    damage: 2,
    radius: 12,
    lifetimeTicks: 100,
    turnRate: 0,
  },
}

export const PHASE_TYPES: readonly (readonly EnemyType[])[] = [
  ['mireling'],
  ['mireling', 'leaper', 'sporecaster'],
  ['mireling', 'leaper', 'sporecaster', 'brute'],
]

export function phaseForTick(tick: number, phaseDurationTicks: number): 1 | 2 | 3 {
  return Math.min(3, Math.floor(tick / phaseDurationTicks) + 1) as 1 | 2 | 3
}
