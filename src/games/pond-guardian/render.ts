import {
  ATTACK_HALF_ANGLE,
  ATTACK_RANGE,
  ATTACK_TICKS,
  ENEMY_SPECS,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  FROG_RADIUS,
  PLAYER_RADIUS,
  PROJECTILE_SPECS,
  type EnemyType,
  type ProjectileType,
} from './sim/constants'
import type { Enemy, PondGuardianState, Projectile } from './sim/types'

const TAU = Math.PI * 2

const COLORS = {
  waterTop: '#12392f',
  waterMid: '#08271f',
  waterBottom: '#03100d',
  waterGlow: '#0b7266',
  padMid: '#244d20',
  padEdge: '#102b18',
  frog: '#8fe33f',
  frogLight: '#ddff91',
  frogShadow: '#347b26',
  frogInk: '#0a2110',
  ink: '#101711',
  warm: '#f5c45d',
  warmHot: '#fff1a5',
  cloth: '#233b62',
  clothLight: '#416188',
  clothShadow: '#111d34',
  steelDark: '#3b4648',
  wood: '#5f4029',
  lotus: '#e172ad',
  lotusDark: '#762f68',
  firefly: '#d8ff69',
  danger: '#ff8e76',
  mireling: '#668f35',
  leaper: '#b85ba8',
  brute: '#776047',
  sporecaster: '#3da996',
  spore: '#b7f55f',
  needle: '#ffd36d',
  shockwave: '#ef79c1',
} as const

const LILY_PADS: readonly { x: number; y: number; rx: number; ry: number; rotation: number }[] = [
  { x: 84, y: 104, rx: 66, ry: 23, rotation: -0.18 },
  { x: 548, y: 98, rx: 76, ry: 25, rotation: 0.14 },
  { x: 105, y: 406, rx: 79, ry: 26, rotation: 0.12 },
  { x: 548, y: 392, rx: 64, ry: 22, rotation: -0.2 },
  { x: 316, y: 72, rx: 48, ry: 17, rotation: -0.08 },
  { x: 478, y: 308, rx: 38, ry: 14, rotation: 0.08 },
  { x: 192, y: 260, rx: 37, ry: 13, rotation: -0.11 },
]

const LOTUSES: readonly { x: number; y: number; scale: number }[] = [
  { x: 66, y: 179, scale: 0.86 },
  { x: 574, y: 290, scale: 1 },
  { x: 248, y: 429, scale: 0.72 },
  { x: 410, y: 92, scale: 0.58 },
]

export interface RenderOptions {
  reducedMotion: boolean
}

type GradientStop = readonly [offset: number, color: string]

function linearGradient(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stops: readonly GradientStop[],
): CanvasGradient {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
  for (const [offset, color] of stops) gradient.addColorStop(offset, color)
  return gradient
}

function radialGradient(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  r0: number,
  x1: number,
  y1: number,
  r1: number,
  stops: readonly GradientStop[],
): CanvasGradient {
  const gradient = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1)
  for (const [offset, color] of stops) gradient.addColorStop(offset, color)
  return gradient
}

function normalize(value: { x: number; y: number }): { x: number; y: number } {
  const length = Math.hypot(value.x, value.y)
  return length <= 0.0001 ? { x: 1, y: 0 } : { x: value.x / length, y: value.y / length }
}

function enemyColor(type: EnemyType): string {
  if (type === 'mireling') return COLORS.mireling
  if (type === 'leaper') return COLORS.leaper
  if (type === 'sporecaster') return COLORS.sporecaster
  return COLORS.brute
}

function projectileColor(type: ProjectileType): string {
  if (type === 'spore') return COLORS.spore
  if (type === 'needle') return COLORS.needle
  return COLORS.shockwave
}

function drawWater(ctx: CanvasRenderingContext2D, tick: number, reducedMotion: boolean): void {
  ctx.fillStyle = linearGradient(ctx, 0, 0, 0, FIELD_HEIGHT, [
    [0, COLORS.waterTop],
    [0.46, COLORS.waterMid],
    [1, COLORS.waterBottom],
  ])
  ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT)

  ctx.fillStyle = radialGradient(ctx, 330, 205, 8, 330, 220, 270, [
    [0, 'rgba(242, 190, 76, 0.2)'],
    [0.3, 'rgba(64, 165, 102, 0.11)'],
    [0.72, 'rgba(6, 45, 39, 0.04)'],
    [1, 'rgba(0, 0, 0, 0)'],
  ])
  ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT)

  const drift = reducedMotion ? 0 : Math.sin(tick / 70) * 7
  ctx.save()
  ctx.lineCap = 'round'
  for (let index = 0; index < 13; index += 1) {
    const y = 38 + index * 34
    const width = 26 + ((index * 31) % 68)
    const x = 42 + ((index * 83) % 548) + drift * (index % 2 === 0 ? 1 : -0.6)
    ctx.strokeStyle = index % 3 === 0 ? 'rgba(112, 232, 194, 0.12)' : 'rgba(242, 198, 91, 0.08)'
    ctx.lineWidth = index % 4 === 0 ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(x - width, y)
    ctx.bezierCurveTo(x - width * 0.35, y - 4, x + width * 0.35, y + 4, x + width, y)
    ctx.stroke()
  }
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = 0.16
  ctx.strokeStyle = COLORS.waterGlow
  ctx.lineWidth = 10
  for (let index = 0; index < 5; index += 1) {
    const x = 96 + index * 119
    const y = 340 + (index % 2) * 62
    ctx.beginPath()
    ctx.ellipse(x, y, 44 + index * 3, 10, -0.1, 0.2, Math.PI * 1.65)
    ctx.stroke()
  }
  ctx.restore()

  ctx.fillStyle = radialGradient(
    ctx,
    FIELD_WIDTH / 2,
    FIELD_HEIGHT / 2,
    130,
    FIELD_WIDTH / 2,
    FIELD_HEIGHT / 2,
    430,
    [
      [0, 'rgba(0, 0, 0, 0)'],
      [0.72, 'rgba(0, 0, 0, 0.1)'],
      [1, 'rgba(0, 4, 3, 0.72)'],
    ],
  )
  ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT)
}

function drawLilyPad(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rotation: number,
  highlight = false,
): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rotation)

  ctx.fillStyle = 'rgba(0, 0, 0, 0.52)'
  ctx.beginPath()
  ctx.ellipse(3, 9, rx * 1.04, ry * 0.92, 0, 0, TAU)
  ctx.fill()

  ctx.fillStyle = COLORS.padEdge
  ctx.strokeStyle = 'rgba(4, 16, 8, 0.88)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.ellipse(0, 5, rx, ry, 0, 0, TAU)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = radialGradient(ctx, -rx * 0.28, -ry * 0.5, 1, 0, 0, rx, [
    [0, highlight ? '#91a83c' : '#5d8732'],
    [0.42, highlight ? '#577d27' : COLORS.padMid],
    [1, '#17371c'],
  ])
  ctx.strokeStyle = highlight ? 'rgba(255, 224, 117, 0.74)' : 'rgba(157, 216, 89, 0.34)'
  ctx.lineWidth = highlight ? 2.5 : 1.5
  ctx.beginPath()
  ctx.ellipse(0, 0, rx, ry, 0, 0, TAU)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = 'rgba(4, 24, 17, 0.82)'
  ctx.beginPath()
  ctx.moveTo(1, 0)
  ctx.lineTo(rx + 2, -ry * 0.38)
  ctx.quadraticCurveTo(rx * 0.7, 0, rx + 2, ry * 0.38)
  ctx.closePath()
  ctx.fill()

  ctx.strokeStyle = highlight ? 'rgba(255, 232, 135, 0.24)' : 'rgba(181, 231, 113, 0.15)'
  ctx.lineWidth = 1
  for (let index = 0; index < 7; index += 1) {
    const angle = -Math.PI * 0.72 + index * 0.24
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.quadraticCurveTo(
      Math.cos(angle) * rx * 0.38,
      Math.sin(angle) * ry * 0.56,
      Math.cos(angle) * rx * 0.86,
      Math.sin(angle) * ry * 0.86,
    )
    ctx.stroke()
  }
  ctx.restore()
}

function drawLotus(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(scale, scale)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)'
  ctx.beginPath()
  ctx.ellipse(2, 8, 26, 8, 0, 0, TAU)
  ctx.fill()

  for (let layer = 0; layer < 2; layer += 1) {
    const count = layer === 0 ? 7 : 5
    for (let index = 0; index < count; index += 1) {
      ctx.save()
      ctx.rotate((index / count) * TAU + layer * 0.32)
      ctx.fillStyle = linearGradient(ctx, 0, 12, 0, -18, [
        [0, COLORS.lotusDark],
        [0.62, COLORS.lotus],
        [1, '#ffc2dd'],
      ])
      ctx.strokeStyle = '#35172f'
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.moveTo(0, 4)
      ctx.bezierCurveTo(-7 + layer * 2, -2, -7 + layer * 2, -13, 0, -20 + layer * 5)
      ctx.bezierCurveTo(7 - layer * 2, -13, 7 - layer * 2, -2, 0, 4)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }
  ctx.shadowColor = COLORS.warm
  ctx.shadowBlur = 9
  ctx.fillStyle = COLORS.warmHot
  ctx.beginPath()
  ctx.arc(0, 0, 3.5, 0, TAU)
  ctx.fill()
  ctx.restore()
}

function drawAmbience(ctx: CanvasRenderingContext2D, tick: number, reducedMotion: boolean): void {
  for (const pad of LILY_PADS) {
    const bob = reducedMotion ? 0 : Math.sin(tick / 46 + pad.x) * 1.7
    drawLilyPad(ctx, pad.x + bob, pad.y, pad.rx, pad.ry, pad.rotation)
  }
  for (const lotus of LOTUSES) drawLotus(ctx, lotus.x, lotus.y, lotus.scale)

  for (let index = 0; index < 18; index += 1) {
    const x = 18 + ((index * 97) % 604)
    const baseY = 28 + ((index * 71) % 420)
    const y = reducedMotion ? baseY : baseY + Math.sin(tick / 31 + index) * 5
    const pulse = reducedMotion ? 0.65 : 0.45 + Math.sin(tick / 24 + index * 2) * 0.22
    ctx.save()
    ctx.globalAlpha = Math.max(0.18, pulse)
    ctx.shadowColor = COLORS.firefly
    ctx.shadowBlur = 12
    ctx.fillStyle = COLORS.firefly
    ctx.beginPath()
    ctx.arc(x, y, index % 5 === 0 ? 2.4 : 1.3, 0, TAU)
    ctx.fill()
    ctx.restore()
  }
}

function drawObjectivePad(
  ctx: CanvasRenderingContext2D,
  state: PondGuardianState,
  reducedMotion: boolean,
): void {
  const { x, y } = state.frog.position
  const pulse = reducedMotion ? 0 : Math.sin(state.tick / 24) * 3
  ctx.save()
  ctx.globalAlpha = 0.15
  ctx.strokeStyle = COLORS.frogLight
  ctx.lineWidth = 7
  ctx.beginPath()
  ctx.ellipse(x, y + 28, 75 + pulse, 31 + pulse * 0.35, -0.04, 0, TAU)
  ctx.stroke()
  ctx.restore()
  drawLilyPad(ctx, x, y + 27, 72, 29, -0.04, true)
}

function drawFrog(
  ctx: CanvasRenderingContext2D,
  state: PondGuardianState,
  reducedMotion: boolean,
): void {
  const { x, y } = state.frog.position
  const bob = reducedMotion ? 0 : Math.sin(state.tick / 22) * 2
  ctx.save()
  ctx.translate(x, y + bob)
  ctx.scale(0.9, 0.9)
  ctx.fillStyle = 'rgba(3, 12, 6, 0.52)'
  ctx.beginPath()
  ctx.ellipse(2, 29, 35, 11, 0, 0, TAU)
  ctx.fill()

  const legGradient = radialGradient(ctx, -8, 14, 1, 0, 18, 31, [
    [0, COLORS.frog],
    [0.66, COLORS.frogShadow],
    [1, COLORS.frogInk],
  ])
  ctx.fillStyle = legGradient
  ctx.strokeStyle = COLORS.frogInk
  ctx.lineWidth = 3.5
  ctx.beginPath()
  ctx.ellipse(-24, 19, 17, 9, -0.3, 0, TAU)
  ctx.ellipse(24, 19, 17, 9, 0.3, 0, TAU)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = radialGradient(ctx, -9, -4, 2, 0, 8, 36, [
    [0, COLORS.frogLight],
    [0.35, COLORS.frog],
    [0.83, COLORS.frogShadow],
    [1, COLORS.frogInk],
  ])
  ctx.beginPath()
  ctx.ellipse(0, 8, 28, 25, 0, 0, TAU)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = radialGradient(ctx, -10, -18, 1, 0, -8, 36, [
    [0, '#e7ff9e'],
    [0.35, '#9bea4b'],
    [0.82, '#4b9d2b'],
    [1, '#173c1c'],
  ])
  ctx.beginPath()
  ctx.ellipse(0, -7, 31, 24, 0, 0, TAU)
  ctx.fill()
  ctx.stroke()

  for (const eyeX of [-18, 18]) {
    ctx.fillStyle = '#dff59b'
    ctx.strokeStyle = COLORS.frogInk
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.ellipse(eyeX, -22, 11, 13, 0, 0, TAU)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = radialGradient(ctx, eyeX - 2, -25, 1, eyeX, -21, 8, [
      [0, '#ffd57b'],
      [0.48, '#7d3c24'],
      [1, '#160f0b'],
    ])
    ctx.beginPath()
    ctx.arc(eyeX, -21, 7, 0, TAU)
    ctx.fill()
    ctx.fillStyle = '#080907'
    ctx.beginPath()
    ctx.arc(eyeX, -21, 3.5, 0, TAU)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(eyeX - 2.4, -24.2, 2.2, 0, TAU)
    ctx.fill()
  }

  ctx.strokeStyle = '#173319'
  ctx.lineWidth = 2.3
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(0, -4, 12, 0.16, Math.PI - 0.16)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255, 166, 153, 0.46)'
  ctx.beginPath()
  ctx.ellipse(-20, -3, 5, 2.5, 0, 0, TAU)
  ctx.ellipse(20, -3, 5, 2.5, 0, 0, TAU)
  ctx.fill()

  ctx.strokeStyle = COLORS.frogInk
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(-16, 14)
  ctx.quadraticCurveTo(-13, 29, -26, 31)
  ctx.moveTo(16, 14)
  ctx.quadraticCurveTo(13, 29, 26, 31)
  ctx.stroke()

  ctx.fillStyle = linearGradient(ctx, 0, 7, 0, 26, [
    [0, '#ffc8e0'],
    [0.55, COLORS.lotus],
    [1, COLORS.lotusDark],
  ])
  ctx.strokeStyle = '#412039'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(0, 12)
  ctx.bezierCurveTo(-7, 18, -6, 25, 0, 29)
  ctx.bezierCurveTo(6, 25, 7, 18, 0, 12)
  ctx.fill()
  ctx.stroke()

  ctx.strokeStyle = 'rgba(255, 244, 172, 0.78)'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.arc(-5, -11, FROG_RADIUS * 0.86, Math.PI * 1.08, Math.PI * 1.55)
  ctx.stroke()
  ctx.restore()

  const healthRatio = state.frog.health / state.frog.maxHealth
  ctx.save()
  ctx.fillStyle = 'rgba(2, 8, 5, 0.76)'
  ctx.strokeStyle = 'rgba(245, 196, 93, 0.45)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(x - 39, y - 62, 78, 8, 4)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = healthRatio > 0.35 ? COLORS.frogLight : COLORS.danger
  ctx.beginPath()
  ctx.roundRect(x - 36, y - 59, 72 * healthRatio, 2.5, 2)
  ctx.fill()
  ctx.restore()
}

function drawMireling(ctx: CanvasRenderingContext2D, radius: number, color: string): void {
  ctx.fillStyle = radialGradient(ctx, -6, -8, 1, 0, 3, radius * 1.3, [
    [0, '#a2bd59'],
    [0.45, color],
    [1, '#253c1c'],
  ])
  ctx.beginPath()
  ctx.moveTo(-radius, 7)
  ctx.bezierCurveTo(-radius - 2, -9, -8, -radius - 7, 0, -radius + 1)
  ctx.bezierCurveTo(10, -radius - 8, radius + 4, -5, radius, 9)
  ctx.quadraticCurveTo(4, radius + 7, -radius, 7)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#f3d371'
  ctx.beginPath()
  ctx.arc(-5, -3, 3.3, 0, TAU)
  ctx.arc(6, -2, 2.6, 0, TAU)
  ctx.fill()
  ctx.fillStyle = COLORS.ink
  ctx.beginPath()
  ctx.arc(-5, -3, 1.5, 0, TAU)
  ctx.arc(6, -2, 1.2, 0, TAU)
  ctx.fill()
}

function drawLeaper(ctx: CanvasRenderingContext2D, radius: number, color: string): void {
  ctx.strokeStyle = '#391933'
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-8, 8)
  ctx.lineTo(-radius - 10, radius + 7)
  ctx.lineTo(-radius - 2, 3)
  ctx.moveTo(8, 8)
  ctx.lineTo(radius + 10, radius + 7)
  ctx.lineTo(radius + 2, 3)
  ctx.stroke()
  ctx.fillStyle = radialGradient(ctx, -5, -7, 1, 0, 2, radius * 1.5, [
    [0, '#f49bd4'],
    [0.48, color],
    [1, '#54214e'],
  ])
  ctx.beginPath()
  ctx.moveTo(0, -radius - 8)
  ctx.bezierCurveTo(radius + 5, -8, radius + 4, 10, 0, radius + 4)
  ctx.bezierCurveTo(-radius - 4, 10, -radius - 5, -8, 0, -radius - 8)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = COLORS.warmHot
  ctx.beginPath()
  ctx.ellipse(0, -4, 3.2, 5, 0, 0, TAU)
  ctx.fill()
}

function drawSporecaster(ctx: CanvasRenderingContext2D, radius: number, color: string): void {
  ctx.strokeStyle = '#163b35'
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  for (let index = 0; index < 5; index += 1) {
    const offset = -12 + index * 6
    ctx.beginPath()
    ctx.moveTo(offset, 4)
    ctx.quadraticCurveTo(offset + (index % 2 === 0 ? -8 : 8), 15, offset - 2, radius + 9)
    ctx.stroke()
  }
  ctx.fillStyle = radialGradient(ctx, -6, -11, 1, 0, -2, radius * 1.7, [
    [0, '#8be1ca'],
    [0.38, color],
    [1, '#145148'],
  ])
  ctx.beginPath()
  ctx.moveTo(-radius - 5, 0)
  ctx.quadraticCurveTo(-radius + 2, -radius - 14, 0, -radius - 15)
  ctx.quadraticCurveTo(radius - 2, -radius - 14, radius + 5, 0)
  ctx.quadraticCurveTo(0, 10, -radius - 5, 0)
  ctx.fill()
  ctx.stroke()
  ctx.shadowColor = COLORS.spore
  ctx.shadowBlur = 10
  ctx.fillStyle = COLORS.spore
  for (const point of [
    [-9, -7],
    [2, -13],
    [10, -4],
  ] as const) {
    ctx.beginPath()
    ctx.arc(point[0], point[1], 2.2, 0, TAU)
    ctx.fill()
  }
  ctx.shadowBlur = 0
  ctx.fillStyle = '#09201c'
  ctx.beginPath()
  ctx.ellipse(0, 1, 5, 3, 0, 0, TAU)
  ctx.fill()
}

function drawBrute(ctx: CanvasRenderingContext2D, radius: number, color: string): void {
  ctx.fillStyle = radialGradient(ctx, -9, -13, 2, 0, 4, radius * 1.65, [
    [0, '#b29a68'],
    [0.42, color],
    [1, '#322b24'],
  ])
  ctx.beginPath()
  ctx.roundRect(-radius - 3, -radius, radius * 2 + 6, radius * 2 + 4, 11)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#425b2c'
  ctx.beginPath()
  ctx.ellipse(-radius + 2, -radius + 5, 9, 5, -0.4, 0, TAU)
  ctx.ellipse(radius - 3, 2, 7, 4, 0.4, 0, TAU)
  ctx.fill()
  ctx.strokeStyle = '#2a241f'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(-10, -radius + 6)
  ctx.lineTo(-2, -7)
  ctx.lineTo(-8, 2)
  ctx.moveTo(15, 8)
  ctx.lineTo(7, 15)
  ctx.stroke()
  ctx.fillStyle = COLORS.warm
  ctx.beginPath()
  ctx.roundRect(-11, -6, 7, 5, 2)
  ctx.roundRect(4, -6, 7, 5, 2)
  ctx.fill()
}

function drawEnemy(ctx: CanvasRenderingContext2D, enemy: Enemy): void {
  const spec = ENEMY_SPECS[enemy.type]
  const { x, y } = enemy.position
  const baseColor = enemyColor(enemy.type)
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.54)'
  ctx.beginPath()
  ctx.ellipse(2, spec.radius * 0.8, spec.radius * 1.18, spec.radius * 0.43, 0, 0, TAU)
  ctx.fill()
  ctx.strokeStyle = COLORS.ink
  ctx.lineWidth = enemy.type === 'brute' ? 4.5 : 3.5
  ctx.lineJoin = 'round'

  if (enemy.type === 'mireling') drawMireling(ctx, spec.radius, baseColor)
  else if (enemy.type === 'leaper') drawLeaper(ctx, spec.radius, baseColor)
  else if (enemy.type === 'sporecaster') drawSporecaster(ctx, spec.radius, baseColor)
  else drawBrute(ctx, spec.radius, baseColor)

  ctx.strokeStyle = 'rgba(255, 223, 121, 0.34)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.arc(-3, -4, spec.radius * 0.82, Math.PI * 1.08, Math.PI * 1.55)
  ctx.stroke()

  if (enemy.hitFlashTicks > 0) {
    ctx.globalCompositeOperation = 'screen'
    ctx.globalAlpha = 0.72
    ctx.fillStyle = '#fff4d2'
    ctx.beginPath()
    ctx.ellipse(0, 0, spec.radius * 1.03, spec.radius * 0.92, 0, 0, TAU)
    ctx.fill()
  }
  ctx.restore()

  if (enemy.state === 'windup') {
    const progress = Math.max(0, Math.min(1, enemy.stateTicks / spec.windupTicks))
    ctx.save()
    ctx.translate(x, y + spec.radius * 0.72)
    ctx.globalAlpha = 0.32 + progress * 0.55
    ctx.strokeStyle = enemy.type === 'sporecaster' ? COLORS.spore : COLORS.warm
    ctx.lineWidth = 2.5
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.ellipse(0, 0, spec.radius + 11 + (1 - progress) * 12, (spec.radius + 9) * 0.38, 0, 0, TAU)
    ctx.stroke()
    ctx.setLineDash([])
    for (let index = 0; index < 4; index += 1) {
      const angle = (index / 4) * TAU
      ctx.beginPath()
      ctx.moveTo(Math.cos(angle) * (spec.radius + 4), Math.sin(angle) * (spec.radius + 4) * 0.38)
      ctx.lineTo(Math.cos(angle) * (spec.radius + 10), Math.sin(angle) * (spec.radius + 10) * 0.38)
      ctx.stroke()
    }
    ctx.restore()
  }

  if (enemy.maxHealth > 1) {
    const width = spec.radius * 2.1
    ctx.fillStyle = 'rgba(1, 7, 4, 0.72)'
    ctx.fillRect(x - width / 2, y - spec.radius - 16, width, 4)
    ctx.fillStyle = COLORS.warm
    ctx.fillRect(x - width / 2, y - spec.radius - 16, width * (enemy.health / enemy.maxHealth), 4)
  }
}

function drawProjectile(ctx: CanvasRenderingContext2D, projectile: Projectile): void {
  const color = projectileColor(projectile.type)
  const spec = PROJECTILE_SPECS[projectile.type]
  const direction = normalize(projectile.velocity)
  ctx.save()
  ctx.shadowColor = color
  ctx.shadowBlur = projectile.type === 'shockwave' ? 14 : 11
  ctx.strokeStyle = color
  ctx.fillStyle = color

  if (projectile.type === 'shockwave') {
    ctx.translate(projectile.position.x, projectile.position.y)
    ctx.globalAlpha = Math.max(0.12, 0.76 - projectile.age / projectile.maxAge)
    ctx.lineWidth = 3.5
    ctx.beginPath()
    ctx.ellipse(0, 0, projectile.travelRadius, projectile.travelRadius * 0.39, 0, 0, TAU)
    ctx.stroke()
    ctx.globalAlpha *= 0.42
    ctx.lineWidth = 12
    ctx.beginPath()
    ctx.ellipse(0, 0, projectile.travelRadius, projectile.travelRadius * 0.39, 0, 0, TAU)
    ctx.stroke()
  } else if (projectile.type === 'needle') {
    ctx.translate(projectile.position.x, projectile.position.y)
    ctx.rotate(Math.atan2(direction.y, direction.x))
    ctx.globalAlpha = 0.35
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(-26, 0)
    ctx.lineTo(-7, 0)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = linearGradient(ctx, -8, -3, 9, 2, [
      [0, '#9b5a2d'],
      [0.48, color],
      [1, '#fff6bc'],
    ])
    ctx.beginPath()
    ctx.moveTo(10, 0)
    ctx.lineTo(-6, -3.5)
    ctx.lineTo(-3, 0)
    ctx.lineTo(-6, 3.5)
    ctx.closePath()
    ctx.fill()
  } else {
    const x = projectile.position.x
    const y = projectile.position.y
    ctx.globalAlpha = 0.34
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(x - direction.x * 16, y - direction.y * 16)
    ctx.quadraticCurveTo(
      x - direction.x * 8 - direction.y * 5,
      y - direction.y * 8 + direction.x * 5,
      x,
      y,
    )
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = radialGradient(ctx, x - 2, y - 3, 1, x, y, spec.radius + 3, [
      [0, '#ffffff'],
      [0.25, COLORS.spore],
      [0.72, '#42984b'],
      [1, '#163f2b'],
    ])
    ctx.beginPath()
    ctx.arc(x, y, spec.radius + 1.5, 0, TAU)
    ctx.fill()
    ctx.strokeStyle = 'rgba(220, 255, 154, 0.64)'
    ctx.lineWidth = 1
    ctx.stroke()
  }
  ctx.restore()
}

function drawWeapon(ctx: CanvasRenderingContext2D, attackProgress: number): void {
  ctx.save()
  ctx.rotate(-0.08 + attackProgress * 0.16)
  ctx.strokeStyle = '#2d2119'
  ctx.lineWidth = 10
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-13, 0)
  ctx.lineTo(59, 0)
  ctx.stroke()
  ctx.strokeStyle = COLORS.wood
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(-12, -1)
  ctx.lineTo(60, -1)
  ctx.stroke()
  ctx.strokeStyle = '#b08a62'
  ctx.lineWidth = 1.5
  for (let x = 4; x < 47; x += 7) {
    ctx.beginPath()
    ctx.moveTo(x, -5)
    ctx.lineTo(x + 3, 4)
    ctx.stroke()
  }

  ctx.fillStyle = linearGradient(ctx, 44, -26, 80, 24, [
    [0, '#d8d6bd'],
    [0.2, '#8d9894'],
    [0.54, COLORS.steelDark],
    [0.82, '#6f7772'],
    [1, '#252d2d'],
  ])
  ctx.strokeStyle = '#172021'
  ctx.lineWidth = 4
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(45, -10)
  ctx.lineTo(59, -27)
  ctx.lineTo(82, -22)
  ctx.lineTo(75, 0)
  ctx.lineTo(83, 17)
  ctx.lineTo(60, 27)
  ctx.lineTo(46, 9)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = 'rgba(255, 239, 173, 0.6)'
  ctx.lineWidth = 1.7
  ctx.beginPath()
  ctx.moveTo(61, -22)
  ctx.lineTo(75, -18)
  ctx.moveTo(60, 21)
  ctx.lineTo(75, 15)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(42, 72, 75, 0.8)'
  ctx.beginPath()
  ctx.arc(61, 0, 7, 0, TAU)
  ctx.stroke()
  ctx.restore()
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  state: PondGuardianState,
  reducedMotion: boolean,
): void {
  const { x, y } = state.player.position
  const aimAngle = Math.atan2(state.player.aim.y, state.player.aim.x)
  const bob = reducedMotion ? 0 : Math.sin(state.tick / 12) * 1.5
  const attackProgress =
    state.player.attackTicksLeft > 0 ? state.player.attackTicksLeft / ATTACK_TICKS : 0
  ctx.save()
  ctx.translate(x, y + bob)

  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'
  ctx.beginPath()
  ctx.ellipse(2, 29, 39, 13, 0, 0, TAU)
  ctx.fill()
  ctx.save()
  ctx.rotate(aimAngle)
  drawWeapon(ctx, attackProgress)
  ctx.restore()

  ctx.save()
  ctx.scale(1.2, 1.2)

  ctx.fillStyle = '#182318'
  ctx.strokeStyle = COLORS.ink
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.roundRect(-23, 7, 18, 28, 8)
  ctx.roundRect(5, 7, 18, 28, 8)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = linearGradient(ctx, -22, -17, 21, 29, [
    [0, COLORS.clothLight],
    [0.38, COLORS.cloth],
    [1, COLORS.clothShadow],
  ])
  ctx.beginPath()
  ctx.moveTo(-25, 28)
  ctx.lineTo(-21, -11)
  ctx.quadraticCurveTo(0, -26, 22, -10)
  ctx.lineTo(28, 29)
  ctx.quadraticCurveTo(0, 38, -25, 28)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  ctx.strokeStyle = '#7c5a35'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(-21, 8)
  ctx.lineTo(23, 8)
  ctx.stroke()
  ctx.strokeStyle = '#c4964c'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(-18, 6)
  ctx.lineTo(20, 6)
  ctx.stroke()

  ctx.fillStyle = '#243c24'
  ctx.strokeStyle = COLORS.ink
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.moveTo(-19, -19)
  ctx.lineTo(-23, -34)
  ctx.lineTo(-12, -25)
  ctx.lineTo(-8, -38)
  ctx.lineTo(0, -27)
  ctx.lineTo(10, -38)
  ctx.lineTo(12, -24)
  ctx.lineTo(24, -32)
  ctx.lineTo(19, -17)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = radialGradient(ctx, -10, -21, 2, 0, -12, 27, [
    [0, '#9fb85a'],
    [0.35, '#547735'],
    [0.78, '#294326'],
    [1, '#142619'],
  ])
  ctx.beginPath()
  ctx.ellipse(0, -17, 22, 20, 0, 0, TAU)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = '#324c2b'
  ctx.strokeStyle = COLORS.ink
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(-21, -5, 10, 0, TAU)
  ctx.arc(21, -5, 10, 0, TAU)
  ctx.fill()
  ctx.stroke()

  const look = normalize(state.player.aim)
  const lookX = look.x * 2
  const lookY = look.y * 1.3
  ctx.strokeStyle = '#152015'
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-14, -25)
  ctx.lineTo(-4, -21)
  ctx.moveTo(14, -25)
  ctx.lineTo(4, -21)
  ctx.stroke()
  ctx.shadowColor = COLORS.warm
  ctx.shadowBlur = 7
  ctx.fillStyle = COLORS.warmHot
  ctx.beginPath()
  ctx.ellipse(-7 + lookX, -20 + lookY, 2.4, 1.8, 0, 0, TAU)
  ctx.ellipse(7 + lookX, -20 + lookY, 2.4, 1.8, 0, 0, TAU)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.strokeStyle = '#172117'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.moveTo(-7, -10)
  ctx.quadraticCurveTo(0, -5, 8, -11)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(255, 222, 124, 0.58)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(-4, -16, 21, Math.PI * 1.02, Math.PI * 1.55)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(112, 147, 73, 0.72)'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(-18, -7)
  ctx.lineTo(-11, -2)
  ctx.moveTo(17, 1)
  ctx.lineTo(10, 5)
  ctx.stroke()
  ctx.restore()
  ctx.restore()

  if (state.player.attackTicksLeft > 0) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(aimAngle)
    const alpha = 0.32 + attackProgress * 0.45
    ctx.globalAlpha = alpha
    ctx.strokeStyle = COLORS.warmHot
    ctx.shadowColor = COLORS.warm
    ctx.shadowBlur = 16
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.arc(0, 0, ATTACK_RANGE, -ATTACK_HALF_ANGLE, ATTACK_HALF_ANGLE)
    ctx.stroke()
    ctx.globalAlpha = alpha * 0.62
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(0, 0, ATTACK_RANGE + 5, -ATTACK_HALF_ANGLE, ATTACK_HALF_ANGLE)
    ctx.stroke()
    ctx.restore()
  }

  if (
    state.player.invulnerableTicks > 0 &&
    Math.floor(state.player.invulnerableTicks / 5) % 2 === 0
  ) {
    ctx.save()
    ctx.translate(x, y + 20)
    ctx.strokeStyle = COLORS.danger
    ctx.lineWidth = 3
    ctx.globalAlpha = 0.7
    ctx.beginPath()
    ctx.ellipse(0, 0, PLAYER_RADIUS + 13, (PLAYER_RADIUS + 13) * 0.4, 0, 0, TAU)
    ctx.stroke()
    ctx.restore()
  }
}

function drawEventFeedback(
  ctx: CanvasRenderingContext2D,
  state: PondGuardianState,
  reducedMotion: boolean,
): void {
  const event = state.lastEvent
  if (event === null || reducedMotion) return
  const age = state.tick - event.tick
  if (age < 0 || age > 20) return
  const progress = age / 20
  const radius = 12 + progress * 30
  ctx.save()
  ctx.globalAlpha = (1 - progress) * 0.72
  ctx.strokeStyle =
    event.kind === 'frog-hit' || event.kind === 'player-hit'
      ? COLORS.danger
      : event.kind === 'projectile-destroyed'
        ? COLORS.spore
        : COLORS.warm
  ctx.shadowColor = ctx.strokeStyle
  ctx.shadowBlur = 9
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.ellipse(event.position.x, event.position.y + 8, radius, radius * 0.42, 0, 0, TAU)
  ctx.stroke()
  if (
    event.kind === 'enemy-hit' ||
    event.kind === 'enemy-defeated' ||
    event.kind === 'projectile-destroyed'
  ) {
    ctx.lineWidth = 2
    for (let index = 0; index < 7; index += 1) {
      const angle = (index / 7) * TAU + event.id
      const inner = radius * 0.5
      const outer = radius + 11 + (index % 2) * 5
      ctx.beginPath()
      ctx.moveTo(
        event.position.x + Math.cos(angle) * inner,
        event.position.y + Math.sin(angle) * inner,
      )
      ctx.lineTo(
        event.position.x + Math.cos(angle) * outer,
        event.position.y + Math.sin(angle) * outer,
      )
      ctx.stroke()
    }
  }
  ctx.restore()
}

function drawForeground(ctx: CanvasRenderingContext2D): void {
  ctx.save()
  ctx.strokeStyle = '#06110b'
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  for (let index = 0; index < 8; index += 1) {
    const leftX = 7 + index * 9
    const rightX = FIELD_WIDTH - 7 - index * 9
    ctx.beginPath()
    ctx.moveTo(leftX, FIELD_HEIGHT + 10)
    ctx.quadraticCurveTo(
      leftX - 12,
      FIELD_HEIGHT - 55 - index * 5,
      leftX + 5,
      FIELD_HEIGHT - 95 - index * 3,
    )
    ctx.moveTo(rightX, FIELD_HEIGHT + 10)
    ctx.quadraticCurveTo(
      rightX + 12,
      FIELD_HEIGHT - 54 - index * 4,
      rightX - 4,
      FIELD_HEIGHT - 91 - index * 4,
    )
    ctx.stroke()
  }
  ctx.fillStyle = linearGradient(ctx, 0, 0, 0, 96, [
    [0, 'rgba(0, 7, 5, 0.78)'],
    [1, 'rgba(0, 7, 5, 0)'],
  ])
  ctx.fillRect(0, 0, FIELD_WIDTH, 96)
  ctx.restore()
}

export function renderGame(
  ctx: CanvasRenderingContext2D,
  state: PondGuardianState,
  options: RenderOptions,
): void {
  ctx.clearRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT)
  drawWater(ctx, state.tick, options.reducedMotion)
  const eventAge = state.lastEvent === null ? 100 : state.tick - state.lastEvent.tick
  const shakeAmount = options.reducedMotion || eventAge > 10 ? 0 : Math.max(0, 5 - eventAge * 0.26)
  const shakeX = shakeAmount * Math.sin(state.tick * 1.7)
  const shakeY = shakeAmount * Math.cos(state.tick * 1.3)

  ctx.save()
  ctx.translate(shakeX, shakeY)
  drawAmbience(ctx, state.tick, options.reducedMotion)
  drawObjectivePad(ctx, state, options.reducedMotion)

  for (const projectile of state.projectiles) {
    if (projectile.type === 'shockwave') drawProjectile(ctx, projectile)
  }

  const actors: { y: number; draw: () => void }[] = [
    {
      y: state.frog.position.y,
      draw: () => drawFrog(ctx, state, options.reducedMotion),
    },
    {
      y: state.player.position.y,
      draw: () => drawPlayer(ctx, state, options.reducedMotion),
    },
    ...state.enemies.map((enemy) => ({
      y: enemy.position.y,
      draw: () => drawEnemy(ctx, enemy),
    })),
    ...state.projectiles
      .filter((projectile) => projectile.type !== 'shockwave')
      .map((projectile) => ({
        y: projectile.position.y,
        draw: () => drawProjectile(ctx, projectile),
      })),
  ]
  actors.sort((left, right) => left.y - right.y)
  for (const actor of actors) actor.draw()

  drawEventFeedback(ctx, state, options.reducedMotion)
  drawForeground(ctx)
  ctx.restore()
}
