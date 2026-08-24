import {
  ARENA_MARGIN,
  ATTACK_DAMAGE,
  ATTACK_HALF_ANGLE,
  ATTACK_KNOCKBACK,
  ATTACK_COOLDOWN_TICKS,
  ATTACK_RANGE,
  ATTACK_TICKS,
  DEFAULT_DURATION_TICKS,
  DEFAULT_PHASE_DURATION_TICKS,
  ENEMY_SPECS,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  FROG_MAX_HEALTH,
  FROG_POSITION,
  FROG_RADIUS,
  INPUT_DEADZONE,
  MAX_ENEMIES,
  PHASE_TYPES,
  PLAYER_MAX_HEALTH,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  PROJECTILE_SPECS,
  PLAYER_START,
  SEPARATION_DISTANCE,
  SEPARATION_FORCE,
  TICKS_PER_SECOND,
  phaseForTick,
  type EnemyType,
  type ProjectileType,
} from './constants'
import { nextRandom, normalizeSeed } from './rng'
import type {
  Enemy,
  EnemyTarget,
  InputFrame,
  PondGuardianConfig,
  PondGuardianEventKind,
  PondGuardianResult,
  PondGuardianState,
  Projectile,
  Vec2,
} from './types'

const DEFAULT_CONFIG: PondGuardianConfig = {
  durationTicks: DEFAULT_DURATION_TICKS,
  phaseDurationTicks: DEFAULT_PHASE_DURATION_TICKS,
  maxEnemies: MAX_ENEMIES,
  spawnRatesPerSecond: [0.95, 1.65, 2.6],
}

const EMPTY_INPUT: InputFrame = {
  move: { x: 0, y: 0 },
  aim: { x: 1, y: 0 },
  attackPressed: false,
}

function cloneVector(value: Vec2): Vec2 {
  return { x: value.x, y: value.y }
}

function vectorLength(value: Vec2): number {
  return Math.hypot(value.x, value.y)
}

function normalize(value: Vec2): Vec2 {
  const length = vectorLength(value)
  return length <= 0.0001 ? { x: 0, y: 0 } : { x: value.x / length, y: value.y / length }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampPosition(position: Vec2, radius: number): void {
  position.x = clamp(position.x, ARENA_MARGIN + radius, FIELD_WIDTH - ARENA_MARGIN - radius)
  position.y = clamp(position.y, ARENA_MARGIN + radius, FIELD_HEIGHT - ARENA_MARGIN - radius)
}

function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function directionFrom(a: Vec2, b: Vec2): Vec2 {
  return normalize({ x: b.x - a.x, y: b.y - a.y })
}

function inputVector(value: Vec2): Vec2 {
  const length = vectorLength(value)
  if (length <= INPUT_DEADZONE) return { x: 0, y: 0 }
  const scaled = Math.min(1, (length - INPUT_DEADZONE) / (1 - INPUT_DEADZONE))
  const direction = { x: value.x / length, y: value.y / length }
  return { x: direction.x * scaled, y: direction.y * scaled }
}

function addEvent(
  state: PondGuardianState,
  kind: PondGuardianEventKind,
  position: Vec2,
  phase?: number,
): void {
  state.eventId += 1
  state.lastEvent = {
    id: state.eventId,
    kind,
    tick: state.tick,
    position: cloneVector(position),
    ...(phase === undefined ? {} : { phase }),
  }
}

function updateScore(state: PondGuardianState): void {
  state.score = state.kills * 10 + state.frog.health * 25 + (state.status === 'won' ? 250 : 0)
}

function phaseTypes(phase: 1 | 2 | 3): readonly EnemyType[] {
  return PHASE_TYPES[phase - 1]
}

function spawnPosition(state: PondGuardianState): Vec2 {
  const random = nextRandom(state.rngState)
  state.rngState = random.state
  const side = Math.floor(random.value * 4)
  const second = nextRandom(state.rngState)
  state.rngState = second.state
  const along =
    ARENA_MARGIN +
    second.value *
      (side % 2 === 0 ? FIELD_HEIGHT - ARENA_MARGIN * 2 : FIELD_WIDTH - ARENA_MARGIN * 2)

  if (side === 0) return { x: ARENA_MARGIN, y: along }
  if (side === 1) return { x: FIELD_WIDTH - ARENA_MARGIN, y: along }
  if (side === 2) return { x: along, y: ARENA_MARGIN }
  return { x: along, y: FIELD_HEIGHT - ARENA_MARGIN }
}

function spawnEnemy(state: PondGuardianState): void {
  const types = phaseTypes(state.phase)
  const random = nextRandom(state.rngState)
  state.rngState = random.state
  const type = types[Math.min(types.length - 1, Math.floor(random.value * types.length))]
  const spec = ENEMY_SPECS[type]
  const position = spawnPosition(state)
  const steering = nextRandom(state.rngState)
  state.rngState = steering.state
  const target: EnemyTarget = spec.target
  state.enemies.push({
    id: state.nextEnemyId,
    type,
    state: 'approach',
    target,
    position,
    velocity: { x: 0, y: 0 },
    health: spec.maxHealth,
    maxHealth: spec.maxHealth,
    stateTicks: 0,
    attackApplied: false,
    attackCooldownTicks: 0,
    hitFlashTicks: 0,
    knockback: { x: 0, y: 0 },
    lastHitAttackId: -1,
    steerPhase: steering.value * Math.PI * 2,
  })
  state.nextEnemyId += 1
}

function applyKnockback(enemy: Enemy, direction: Vec2): void {
  enemy.knockback = {
    x: direction.x * ATTACK_KNOCKBACK,
    y: direction.y * ATTACK_KNOCKBACK,
  }
}

function isInAttackArcAtPosition(
  state: PondGuardianState,
  position: Vec2,
  targetRadius: number,
): boolean {
  const fromPlayer = directionFrom(state.player.position, position)
  const aim = normalize(state.player.aim)
  const dot = aim.x * fromPlayer.x + aim.y * fromPlayer.y
  const angle = Math.acos(clamp(dot, -1, 1))
  const range = ATTACK_RANGE + targetRadius
  return (
    distanceSquared(state.player.position, position) <= range * range && angle <= ATTACK_HALF_ANGLE
  )
}

function isInAttackArc(state: PondGuardianState, enemy: Enemy): boolean {
  return isInAttackArcAtPosition(state, enemy.position, enemyRadius(enemy.type))
}

function enemyRadius(type: EnemyType): number {
  return ENEMY_SPECS[type].radius
}

function targetPosition(state: PondGuardianState, target: EnemyTarget): Vec2 {
  return target === 'player' ? state.player.position : state.frog.position
}

function targetRadius(target: EnemyTarget): number {
  return target === 'player' ? PLAYER_RADIUS : FROG_RADIUS
}

function addProjectile(
  state: PondGuardianState,
  type: ProjectileType,
  position: Vec2,
  direction: Vec2,
  target: EnemyTarget,
): void {
  const spec = PROJECTILE_SPECS[type]
  state.projectiles.push({
    id: state.nextProjectileId,
    type,
    position: cloneVector(position),
    velocity:
      type === 'shockwave'
        ? { x: 0, y: 0 }
        : { x: direction.x * spec.speed, y: direction.y * spec.speed },
    target,
    age: 0,
    maxAge: spec.lifetimeTicks,
    radius: spec.radius,
    travelRadius: 0,
    damage: spec.damage,
    turnRate: spec.turnRate,
    lastHitAttackId: -1,
  })
  state.nextProjectileId += 1
}

function fireProjectileBurst(
  state: PondGuardianState,
  enemy: Enemy,
  projectileType: ProjectileType,
  count: number,
  spread: number,
): void {
  const target = targetPosition(state, enemy.target)
  const base = directionFrom(enemy.position, target)
  const baseAngle = Math.atan2(base.y, base.x)
  const total = Math.max(1, count)

  for (let index = 0; index < total; index += 1) {
    const offset = total === 1 ? 0 : ((index / (total - 1)) * 2 - 1) * spread
    let type = projectileType
    if (projectileType === 'spore' && state.tick % 3 === 0 && index === Math.floor(total / 2)) {
      type = 'needle'
    }
    addProjectile(
      state,
      type,
      enemy.position,
      { x: Math.cos(baseAngle + offset), y: Math.sin(baseAngle + offset) },
      enemy.target,
    )
  }
  addEvent(state, 'projectile-fired', enemy.position)
}

function attackEnemies(state: PondGuardianState): void {
  if (state.player.attackTicksLeft <= 0) return
  for (const enemy of state.enemies) {
    if (enemy.state === 'dead' || enemy.lastHitAttackId === state.player.attackId) continue
    if (!isInAttackArc(state, enemy)) continue

    enemy.lastHitAttackId = state.player.attackId
    state.attackHitIds.push(enemy.id)
    enemy.health -= ATTACK_DAMAGE
    enemy.hitFlashTicks = 8
    applyKnockback(enemy, directionFrom(state.player.position, enemy.position))
    if (enemy.health <= 0) {
      enemy.state = 'dead'
      state.kills += 1
      addEvent(state, 'enemy-defeated', enemy.position)
    } else {
      enemy.state = 'stagger'
      enemy.stateTicks = 16
      addEvent(state, 'enemy-hit', enemy.position)
    }
  }
}

function attackProjectiles(state: PondGuardianState): void {
  if (state.player.attackTicksLeft <= 0) return
  for (const projectile of state.projectiles) {
    if (projectile.lastHitAttackId === state.player.attackId) continue
    if (!isInAttackArcAtPosition(state, projectile.position, projectile.radius)) continue
    projectile.lastHitAttackId = state.player.attackId
    projectile.age = projectile.maxAge
    addEvent(state, 'projectile-destroyed', projectile.position)
  }
}

function movePlayer(state: PondGuardianState, input: InputFrame): void {
  const movement = inputVector(input.move)
  state.player.position.x += (movement.x * PLAYER_SPEED) / TICKS_PER_SECOND
  state.player.position.y += (movement.y * PLAYER_SPEED) / TICKS_PER_SECOND
  clampPosition(state.player.position, PLAYER_RADIUS)

  const aim = inputVector(input.aim)
  if (vectorLength(aim) > 0) state.player.aim = normalize(aim)

  state.player.attackCooldownTicks = Math.max(0, state.player.attackCooldownTicks - 1)
  state.player.invulnerableTicks = Math.max(0, state.player.invulnerableTicks - 1)
  if (input.attackPressed && state.player.attackCooldownTicks === 0) {
    state.player.attackCooldownTicks = ATTACK_COOLDOWN_TICKS
    state.player.attackTicksLeft = ATTACK_TICKS
    state.player.attackId += 1
    state.attackHitIds = []
  }
  attackEnemies(state)
  attackProjectiles(state)
  state.player.attackTicksLeft = Math.max(0, state.player.attackTicksLeft - 1)
}

function applyEnemyAttack(state: PondGuardianState, enemy: Enemy): void {
  const spec = ENEMY_SPECS[enemy.type]
  if (enemy.target === 'player') {
    if (state.player.invulnerableTicks > 0) return
    state.player.health = Math.max(0, state.player.health - spec.damage)
    state.player.invulnerableTicks = 48
    addEvent(state, 'player-hit', state.player.position)
    return
  }

  state.frog.health = Math.max(0, state.frog.health - spec.damage)
  addEvent(state, 'frog-hit', state.frog.position)
}

function approachDirection(
  state: PondGuardianState,
  enemy: Enemy,
  target: Vec2,
  distance: number,
): Vec2 {
  const direct = directionFrom(enemy.position, target)
  const tangent = { x: -direct.y, y: direct.x }
  const spec = ENEMY_SPECS[enemy.type]

  if (spec.attackStyle === 'dash') {
    const weave = Math.sin(state.tick / 16 + enemy.steerPhase) * 0.62
    return normalize({ x: direct.x + tangent.x * weave, y: direct.y + tangent.y * weave })
  }

  if (spec.attackStyle === 'ranged') {
    const radial =
      distance > 215 ? direct : distance < 155 ? { x: -direct.x, y: -direct.y } : { x: 0, y: 0 }
    const orbit = Math.sin(state.tick / 32 + enemy.steerPhase) >= 0 ? 1 : -1
    return normalize({
      x: radial.x + tangent.x * orbit * 0.9,
      y: radial.y + tangent.y * orbit * 0.9,
    })
  }

  return direct
}

function updateEnemy(state: PondGuardianState, enemy: Enemy): void {
  const spec = ENEMY_SPECS[enemy.type]
  enemy.attackCooldownTicks = Math.max(0, enemy.attackCooldownTicks - 1)
  enemy.hitFlashTicks = Math.max(0, enemy.hitFlashTicks - 1)

  if (enemy.state === 'dead') return

  if (enemy.state === 'stagger') {
    enemy.position.x += enemy.knockback.x / TICKS_PER_SECOND
    enemy.position.y += enemy.knockback.y / TICKS_PER_SECOND
    enemy.knockback.x *= 0.78
    enemy.knockback.y *= 0.78
    clampPosition(enemy.position, spec.radius)
    enemy.stateTicks -= 1
    if (enemy.stateTicks <= 0) enemy.state = 'approach'
    return
  }

  const target = targetPosition(state, enemy.target)
  const targetSize = targetRadius(enemy.target)
  const distance = Math.sqrt(distanceSquared(enemy.position, target))

  if (enemy.state === 'windup') {
    enemy.stateTicks -= 1
    if (enemy.stateTicks <= 0) {
      enemy.state = 'attack'
      enemy.stateTicks = spec.attackTicks
      enemy.attackApplied = false
      if (spec.attackStyle === 'dash') {
        const dashDirection = directionFrom(enemy.position, target)
        const dashSpeed = spec.dashSpeed ?? spec.speed
        enemy.velocity = { x: dashDirection.x * dashSpeed, y: dashDirection.y * dashSpeed }
      }
    }
    return
  }

  if (enemy.state === 'attack') {
    if (spec.attackStyle === 'dash') {
      enemy.position.x += enemy.velocity.x / TICKS_PER_SECOND
      enemy.position.y += enemy.velocity.y / TICKS_PER_SECOND
      clampPosition(enemy.position, spec.radius)
    }

    if (!enemy.attackApplied) {
      if (spec.attackStyle === 'ranged' && spec.projectileType !== undefined) {
        fireProjectileBurst(
          state,
          enemy,
          spec.projectileType,
          spec.projectileCount ?? 1,
          spec.projectileSpread ?? 0,
        )
        enemy.attackApplied = true
      } else if (spec.attackStyle === 'shockwave' && spec.projectileType !== undefined) {
        fireProjectileBurst(
          state,
          enemy,
          spec.projectileType,
          spec.projectileCount ?? 1,
          spec.projectileSpread ?? 0,
        )
        enemy.attackApplied = true
      } else if (
        spec.attackStyle !== 'dash' ||
        distanceSquared(enemy.position, target) <= (spec.attackRange + targetSize) ** 2
      ) {
        applyEnemyAttack(state, enemy)
        enemy.attackApplied = true
      }
    }

    enemy.stateTicks -= 1
    if (enemy.stateTicks <= 0) {
      enemy.state = 'approach'
      enemy.attackCooldownTicks = spec.attackCooldownTicks
      enemy.attackApplied = false
      enemy.velocity = { x: 0, y: 0 }
    }
    return
  }

  if (distance <= spec.attackRange + targetSize && enemy.attackCooldownTicks === 0) {
    enemy.state = 'windup'
    enemy.stateTicks = spec.windupTicks
    enemy.velocity = { x: 0, y: 0 }
    return
  }

  const direction = approachDirection(state, enemy, target, distance)
  enemy.velocity = { x: direction.x * spec.speed, y: direction.y * spec.speed }
  enemy.position.x += enemy.velocity.x / TICKS_PER_SECOND
  enemy.position.y += enemy.velocity.y / TICKS_PER_SECOND
  clampPosition(enemy.position, spec.radius)
}

function separateEnemies(state: PondGuardianState): void {
  for (let i = 0; i < state.enemies.length; i += 1) {
    const first = state.enemies[i]
    if (first.state === 'dead') continue
    for (let j = i + 1; j < state.enemies.length; j += 1) {
      const second = state.enemies[j]
      if (second.state === 'dead') continue
      const dx = second.position.x - first.position.x
      const dy = second.position.y - first.position.y
      const distance = Math.hypot(dx, dy)
      if (distance <= 0.0001 || distance >= SEPARATION_DISTANCE) continue
      const push = ((SEPARATION_DISTANCE - distance) / distance) * SEPARATION_FORCE
      second.position.x += dx * push * 0.01
      second.position.y += dy * push * 0.01
      first.position.x -= dx * push * 0.01
      first.position.y -= dy * push * 0.01
      clampPosition(first.position, enemyRadius(first.type))
      clampPosition(second.position, enemyRadius(second.type))
    }
  }
}

function projectileHitsTarget(state: PondGuardianState, projectile: Projectile): boolean {
  const target = targetPosition(state, projectile.target)
  const distance = Math.sqrt(distanceSquared(projectile.position, target))
  if (projectile.type === 'shockwave') {
    return (
      Math.abs(distance - projectile.travelRadius) <=
      projectile.radius + targetRadius(projectile.target)
    )
  }
  return distance <= projectile.radius + targetRadius(projectile.target)
}

function applyProjectileDamage(state: PondGuardianState, projectile: Projectile): void {
  if (projectile.target === 'player') {
    if (state.player.invulnerableTicks > 0) return
    state.player.health = Math.max(0, state.player.health - projectile.damage)
    state.player.invulnerableTicks = 48
    addEvent(state, 'player-hit', state.player.position)
    return
  }

  state.frog.health = Math.max(0, state.frog.health - projectile.damage)
  addEvent(state, 'frog-hit', state.frog.position)
}

function wrappedAngleDelta(target: number, current: number): number {
  let delta = target - current
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

function updateProjectiles(state: PondGuardianState): void {
  const active: Projectile[] = []

  for (const projectile of state.projectiles) {
    const spec = PROJECTILE_SPECS[projectile.type]
    projectile.age += 1

    if (projectile.type === 'shockwave') {
      projectile.travelRadius += spec.speed / TICKS_PER_SECOND
    } else if (projectile.turnRate > 0) {
      const desired = directionFrom(projectile.position, targetPosition(state, projectile.target))
      const currentAngle = Math.atan2(projectile.velocity.y, projectile.velocity.x)
      const desiredAngle = Math.atan2(desired.y, desired.x)
      const angle =
        currentAngle +
        clamp(
          wrappedAngleDelta(desiredAngle, currentAngle),
          -projectile.turnRate,
          projectile.turnRate,
        )
      projectile.velocity = { x: Math.cos(angle) * spec.speed, y: Math.sin(angle) * spec.speed }
    }

    if (projectile.type !== 'shockwave') {
      projectile.position.x += projectile.velocity.x / TICKS_PER_SECOND
      projectile.position.y += projectile.velocity.y / TICKS_PER_SECOND
    }

    if (projectileHitsTarget(state, projectile)) {
      addEvent(state, 'projectile-hit', projectile.position)
      applyProjectileDamage(state, projectile)
      projectile.age = projectile.maxAge
    }

    const outsideArena =
      projectile.type !== 'shockwave' &&
      (projectile.position.x < -40 ||
        projectile.position.x > FIELD_WIDTH + 40 ||
        projectile.position.y < -40 ||
        projectile.position.y > FIELD_HEIGHT + 40)
    if (outsideArena) projectile.age = projectile.maxAge

    if (projectile.age < projectile.maxAge) active.push(projectile)
  }

  state.projectiles = active
}

function updatePhase(state: PondGuardianState): void {
  const nextPhase = phaseForTick(state.tick, state.config.phaseDurationTicks)
  if (nextPhase === state.phase) return
  state.phase = nextPhase
  state.spawnAccumulator += 1.8
  addEvent(state, 'phase', state.frog.position, nextPhase)
}

function updateSpawner(state: PondGuardianState): void {
  const rate = state.config.spawnRatesPerSecond[state.phase - 1]
  state.spawnAccumulator += rate / TICKS_PER_SECOND
  while (
    state.spawnAccumulator >= 1 &&
    state.enemies.filter((enemy) => enemy.state !== 'dead').length < state.config.maxEnemies
  ) {
    spawnEnemy(state)
    state.spawnAccumulator -= 1
  }
}

function finishIfNeeded(state: PondGuardianState): void {
  if (state.frog.health <= 0 || state.player.health <= 0) {
    state.status = 'lost'
    addEvent(state, 'defeat', state.frog.health <= 0 ? state.frog.position : state.player.position)
  } else if (state.tick >= state.config.durationTicks) {
    state.status = 'won'
    addEvent(state, 'victory', state.frog.position)
  }
  updateScore(state)
}

export function createGame(
  seed: number,
  overrides: Partial<PondGuardianConfig> = {},
): PondGuardianState {
  const config: PondGuardianConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
    spawnRatesPerSecond: overrides.spawnRatesPerSecond ?? DEFAULT_CONFIG.spawnRatesPerSecond,
  }
  return {
    seed: normalizeSeed(seed),
    rngState: normalizeSeed(seed),
    config,
    tick: 0,
    phase: 1,
    status: 'playing',
    player: {
      position: { ...PLAYER_START },
      aim: { x: 1, y: 0 },
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
      invulnerableTicks: 0,
      attackCooldownTicks: 0,
      attackTicksLeft: 0,
      attackId: 0,
    },
    frog: {
      position: { ...FROG_POSITION },
      health: FROG_MAX_HEALTH,
      maxHealth: FROG_MAX_HEALTH,
    },
    enemies: [],
    projectiles: [],
    nextEnemyId: 1,
    nextProjectileId: 1,
    spawnAccumulator: 0,
    kills: 0,
    score: FROG_MAX_HEALTH * 25,
    eventId: 0,
    lastEvent: null,
    attackHitIds: [],
  }
}

export function stepGame(
  state: PondGuardianState,
  input: InputFrame = EMPTY_INPUT,
): PondGuardianState {
  if (state.status !== 'playing') return state

  movePlayer(state, input)
  for (const enemy of state.enemies) updateEnemy(state, enemy)
  separateEnemies(state)
  state.enemies = state.enemies.filter((enemy) => enemy.state !== 'dead')
  updateProjectiles(state)
  updateSpawner(state)
  state.tick += 1
  updatePhase(state)
  finishIfNeeded(state)
  return state
}

export function replayGame(
  seed: number,
  inputs: readonly InputFrame[],
  overrides: Partial<PondGuardianConfig> = {},
): PondGuardianState {
  const state = createGame(seed, overrides)
  for (const input of inputs) {
    stepGame(state, input)
    if (state.status !== 'playing') break
  }
  return state
}

export function resultForState(state: PondGuardianState): PondGuardianResult {
  return {
    outcome: state.status === 'won' ? 'victory' : 'defeat',
    score: state.score,
    kills: state.kills,
    frogHealth: state.frog.health,
    playerHealth: state.player.health,
    elapsedTicks: state.tick,
  }
}

export function emptyInput(): InputFrame {
  return {
    move: cloneVector(EMPTY_INPUT.move),
    aim: cloneVector(EMPTY_INPUT.aim),
    attackPressed: false,
  }
}
