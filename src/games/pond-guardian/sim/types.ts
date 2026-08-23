import type { EnemyType, ProjectileType } from './constants'

export interface Vec2 {
  x: number
  y: number
}

export type GameStatus = 'playing' | 'won' | 'lost'
export type EnemyState = 'approach' | 'windup' | 'attack' | 'stagger' | 'dead'
export type EnemyTarget = 'frog' | 'player'

export interface InputFrame {
  move: Vec2
  aim: Vec2
  attackPressed: boolean
}

export interface PlayerState {
  position: Vec2
  aim: Vec2
  health: number
  maxHealth: number
  invulnerableTicks: number
  attackCooldownTicks: number
  attackTicksLeft: number
  attackId: number
}

export interface FrogState {
  position: Vec2
  health: number
  maxHealth: number
}

export interface Enemy {
  id: number
  type: EnemyType
  state: EnemyState
  target: EnemyTarget
  position: Vec2
  velocity: Vec2
  health: number
  maxHealth: number
  stateTicks: number
  attackApplied: boolean
  attackCooldownTicks: number
  hitFlashTicks: number
  knockback: Vec2
  lastHitAttackId: number
  steerPhase: number
}

export interface Projectile {
  id: number
  type: ProjectileType
  position: Vec2
  velocity: Vec2
  target: EnemyTarget
  age: number
  maxAge: number
  radius: number
  travelRadius: number
  damage: number
  turnRate: number
  lastHitAttackId: number
}

export type PondGuardianEventKind =
  | 'phase'
  | 'player-hit'
  | 'frog-hit'
  | 'enemy-hit'
  | 'enemy-defeated'
  | 'projectile-fired'
  | 'projectile-hit'
  | 'projectile-destroyed'
  | 'victory'
  | 'defeat'

export interface PondGuardianEvent {
  id: number
  kind: PondGuardianEventKind
  tick: number
  position: Vec2
  phase?: number
}

export interface PondGuardianConfig {
  durationTicks: number
  phaseDurationTicks: number
  maxEnemies: number
  spawnRatesPerSecond: readonly [number, number, number]
}

export interface PondGuardianState {
  seed: number
  rngState: number
  config: PondGuardianConfig
  tick: number
  phase: 1 | 2 | 3
  status: GameStatus
  player: PlayerState
  frog: FrogState
  enemies: Enemy[]
  projectiles: Projectile[]
  nextEnemyId: number
  nextProjectileId: number
  spawnAccumulator: number
  kills: number
  score: number
  eventId: number
  lastEvent: PondGuardianEvent | null
  attackHitIds: number[]
}

export interface PondGuardianResult {
  outcome: 'victory' | 'defeat'
  score: number
  kills: number
  frogHealth: number
  playerHealth: number
  elapsedTicks: number
}
