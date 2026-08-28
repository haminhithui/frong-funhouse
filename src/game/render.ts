import { FLY_TYPE_BY_ID, PADDLE_HEIGHT, PADDLE_WIDTH, PADDLE_Y } from './sim/constants'
import { dsin } from './sim/dsin'
import { createRng } from './sim/rng'
import type { Fly, FlyTypeId, GameState } from './sim/types'

/**
 * Canvas renderer. Pure presentation: reads sim state, owns no game logic.
 * Palette mirrors src/styles/tokens.css — canvas cannot read CSS custom properties.
 * All cosmetic effects are deterministic functions of (seed, tick) and are
 * suppressed under reduced motion; gameplay motion is never touched.
 */
const COLORS = {
  waterTop: '#18362f',
  waterMid: '#102a25',
  waterBottom: '#080f0e',
  waterGlow: 'rgba(83, 148, 134, 0.18)',
  waterLine: 'rgba(185, 239, 131, 0.35)',
  pad: '#1d2a22',
  padHighlight: '#31583c',
  padRing: 'rgba(185, 239, 131, 0.28)',
  ink: '#ece7dc',
  accent: '#9cdb62',
  accentBright: '#b9ef83',
  accentInk: '#101a08',
  gnat: '#a39c8f',
  midge: '#ece7dc',
  drifter: '#6ea8c9',
  firefly: '#b9ef83',
  queen: '#e8c56d',
} as const

/** Fly palette, shared with the attract-screen legend glyphs (GameApp). */
export const FLY_COLORS: Record<FlyTypeId, string> = {
  gnat: COLORS.gnat,
  midge: COLORS.midge,
  drifter: COLORS.drifter,
  firefly: COLORS.firefly,
  queen: COLORS.queen,
}

/** Cosmetic effect lifetimes in sim ticks. */
const SPLASH_TICKS = 30
const CATCH_FX_TICKS = 42

export interface RenderAssets {
  frong: HTMLImageElement | null
}

export interface RenderOptions {
  reducedMotion: boolean
}

export function renderGame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  assets: RenderAssets,
  options: RenderOptions,
): void {
  const { fieldWidth: w, fieldHeight: h } = state.config

  drawWater(ctx, w, h)
  drawAmbience(ctx, state, options.reducedMotion)
  drawSplash(ctx, state, options.reducedMotion)

  for (const fly of state.flies) {
    if (!fly.caught && !fly.missed) drawFly(ctx, fly, state.tick, options.reducedMotion)
  }

  drawCatchFx(ctx, state, options.reducedMotion)
  drawPadAndFrong(ctx, state, assets, options.reducedMotion)
  drawSurface(ctx, state, options.reducedMotion)
}

function drawWater(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, h)
  gradient.addColorStop(0, COLORS.waterTop)
  gradient.addColorStop(0.42, COLORS.waterMid)
  gradient.addColorStop(1, COLORS.waterBottom)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, w, h)

  // A broad central pool keeps the play space readable without flattening the water.
  const pool = ctx.createRadialGradient(w * 0.5, h * 0.34, 0, w * 0.5, h * 0.34, h * 0.78)
  pool.addColorStop(0, COLORS.waterGlow)
  pool.addColorStop(0.58, 'rgba(83, 148, 134, 0.035)')
  pool.addColorStop(1, 'rgba(8, 15, 14, 0)')
  ctx.fillStyle = pool
  ctx.fillRect(0, 0, w, h)

  // Quiet contour lines make the water feel wide and layered at game scale.
  ctx.save()
  ctx.lineCap = 'round'
  for (let i = 0; i < 10; i += 1) {
    const y = 34 + i * ((h - 88) / 9)
    ctx.globalAlpha = i % 3 === 0 ? 0.11 : 0.055
    ctx.strokeStyle = i % 2 === 0 ? COLORS.accentBright : '#6ea8c9'
    ctx.lineWidth = i % 3 === 0 ? 1.25 : 0.75
    ctx.beginPath()
    ctx.moveTo(-20, y)
    for (let segment = 0; segment <= 8; segment += 1) {
      const x = (segment / 8) * (w + 40) - 20
      const wave = 4 * dsin(segment * 1.65 + i * 0.8)
      ctx.lineTo(x, y + wave)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 0.08
  ctx.strokeStyle = COLORS.accentBright
  ctx.lineWidth = 1
  for (let i = 0; i < 5; i += 1) {
    ctx.beginPath()
    ctx.ellipse(
      w * (0.12 + i * 0.19),
      h * (0.22 + (i % 2) * 0.18),
      22 + i * 5,
      5,
      -0.12,
      0,
      Math.PI * 2,
    )
    ctx.stroke()
  }
  ctx.restore()

  // Vignette: gently darken the edges for depth.
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85)
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.4)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, w, h)
}

/** Seeded ambient scenery: distant lily pads, drifting bubbles, faint light rays. */
function drawAmbience(ctx: CanvasRenderingContext2D, state: GameState, reduced: boolean): void {
  const { fieldWidth: w, fieldHeight: h } = state.config
  const rng = createRng((state.seed ^ 0xa5f1c9) >>> 0)

  // Distant lily pads — static scenery with a slow bob under full motion.
  for (let i = 0; i < 4; i += 1) {
    const px = 34 + rng() * (w - 68)
    const py = 58 + rng() * h * 0.32
    const pr = 12 + rng() * 11
    const bob = reduced ? 0 : 5 * dsin(state.tick / 240 + i * 0.37)
    ctx.save()
    ctx.fillStyle = 'rgba(29, 42, 34, 0.68)'
    ctx.strokeStyle = 'rgba(185, 239, 131, 0.12)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.ellipse(px + bob, py, pr, pr * 0.42, 0.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.strokeStyle = 'rgba(49, 88, 60, 0.7)'
    ctx.beginPath()
    ctx.moveTo(px + bob - pr * 0.7, py + pr * 0.08)
    ctx.lineTo(px + bob + pr * 0.65, py - pr * 0.12)
    ctx.stroke()
    ctx.restore()
  }

  // A few distant reeds frame the lower waterline without covering the player.
  ctx.save()
  ctx.strokeStyle = 'rgba(8, 15, 14, 0.72)'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  for (let i = 0; i < 9; i += 1) {
    const x = (i + 0.5) * (w / 9)
    const reedHeight = 18 + ((i * 17) % 28)
    ctx.beginPath()
    ctx.moveTo(x, h)
    ctx.quadraticCurveTo(
      x - 4 + (i % 2) * 8,
      h - reedHeight * 0.55,
      x + (i % 2 ? 5 : -5),
      h - reedHeight,
    )
    ctx.stroke()
  }
  ctx.restore()

  // Firefly beacons add a second, warmer layer of depth around the targets.
  const fireflyRng = createRng((state.seed ^ 0x37d24a) >>> 0)
  for (let i = 0; i < 12; i += 1) {
    const fx = 24 + fireflyRng() * (w - 48)
    const fy = 28 + fireflyRng() * (h * 0.62)
    const drift = reduced ? 0 : 3 * dsin(state.tick / 85 + i * 0.73)
    const pulse = reduced ? 1 : 0.7 + 0.3 * (0.5 + 0.5 * dsin(state.tick / 18 + i))
    ctx.save()
    ctx.globalAlpha = 0.18 * pulse
    ctx.fillStyle = COLORS.firefly
    ctx.shadowColor = COLORS.firefly
    ctx.shadowBlur = reduced ? 0 : 8
    ctx.beginPath()
    ctx.arc(fx + drift, fy, 1.4 + pulse * 0.7, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  // Rising bubbles.
  if (!reduced) {
    for (let i = 0; i < 8; i += 1) {
      const bx = 30 + rng() * (w - 60)
      const phase = rng()
      const speed = 0.045 + rng() * 0.075
      const y = h - 44 - ((state.tick * speed + phase) % 1) * (h - 88)
      const wobble = 5 * dsin(state.tick / 90 + phase * 2)
      const radius = 2 + rng() * 3
      ctx.globalAlpha = 0.04 + 0.05 * (0.5 + 0.5 * dsin(state.tick / 60 + i))
      ctx.strokeStyle = COLORS.accentBright
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(bx + wobble, y, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // Soft diagonal light rays.
  const rayAlpha = reduced ? 0.05 : 0.04 + 0.03 * dsin(state.tick / 180)
  ctx.globalAlpha = rayAlpha
  for (let i = 0; i < 3; i += 1) {
    const rx = (i / 3) * w - w * 0.18
    const ray = ctx.createLinearGradient(rx, 0, rx + w * 0.55, 0)
    ray.addColorStop(0, 'rgba(185, 239, 131, 0)')
    ray.addColorStop(0.5, COLORS.accentBright)
    ray.addColorStop(1, 'rgba(185, 239, 131, 0)')
    ctx.fillStyle = ray
    ctx.save()
    ctx.translate(rx, 0)
    ctx.rotate(-0.5)
    ctx.fillRect(0, -90, w * 0.55, h + 180)
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

/** Expanding ring + droplets where a fly hit the water. */
function drawSplash(ctx: CanvasRenderingContext2D, state: GameState, reduced: boolean): void {
  if (reduced || state.lastEvent !== 'miss') return
  const age = state.tick - state.lastEventTick
  if (age < 0 || age >= SPLASH_TICKS) return
  const p = age / SPLASH_TICKS
  const sx = state.lastEventX
  const sy = state.config.fieldHeight - 10

  ctx.globalAlpha = (1 - p) * 0.45
  ctx.strokeStyle = COLORS.accentBright
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.ellipse(sx, sy, 6 + p * 34, (6 + p * 34) * 0.26, 0, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = COLORS.waterLine
  for (let i = 0; i < 5; i += 1) {
    const angle = -Math.PI / 2 + (i - 2) * 0.55
    const dist = 8 + p * 30
    ctx.globalAlpha = (1 - p) * 0.5
    ctx.beginPath()
    ctx.arc(
      sx + Math.cos(angle) * dist,
      sy + Math.sin(angle) * dist * 0.5 - p * 9,
      2.2,
      0,
      Math.PI * 2,
    )
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/** Catch ring + rising "+N" score floater at the catch point. */
function drawCatchFx(ctx: CanvasRenderingContext2D, state: GameState, reduced: boolean): void {
  if (reduced || state.lastEvent !== 'catch' || state.lastCaughtType === null) return
  const age = state.tick - state.lastEventTick
  if (age < 0 || age >= CATCH_FX_TICKS) return
  const p = age / CATCH_FX_TICKS

  ctx.strokeStyle = COLORS.accentBright
  ctx.globalAlpha = (1 - p) * 0.55
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(state.paddleX, PADDLE_Y - 12, 30 + p * 40, 0, Math.PI * 2)
  ctx.stroke()

  const points = FLY_TYPE_BY_ID[state.lastCaughtType].points
  ctx.globalAlpha = 1 - p * p
  ctx.fillStyle = FLY_COLORS[state.lastCaughtType]
  ctx.font = '700 20px ui-monospace, "Cascadia Mono", Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.fillText(`+${points}`, state.lastEventX, PADDLE_Y - 44 - p * 34)
  ctx.globalAlpha = 1
}

/** Lily pad + FRONG catcher (avatar image, drawn-frog fallback). */
function drawPadAndFrong(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  assets: RenderAssets,
  reduced: boolean,
): void {
  const padY = PADDLE_Y + PADDLE_HEIGHT / 2 + 12
  const bob = reduced ? 0 : 1.5 * dsin(state.tick / 26)

  ctx.save()
  const padGradient = ctx.createRadialGradient(
    state.paddleX - 12,
    padY - 6 + bob,
    2,
    state.paddleX,
    padY + bob,
    PADDLE_WIDTH / 2 + 22,
  )
  padGradient.addColorStop(0, COLORS.padHighlight)
  padGradient.addColorStop(1, COLORS.pad)
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
  ctx.shadowBlur = 14
  ctx.fillStyle = padGradient
  ctx.strokeStyle = COLORS.padRing
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.ellipse(state.paddleX, padY + bob, PADDLE_WIDTH / 2 + 16, 16, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.stroke()

  ctx.strokeStyle = 'rgba(185, 239, 131, 0.28)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(state.paddleX - PADDLE_WIDTH / 2, padY - 1 + bob)
  ctx.quadraticCurveTo(
    state.paddleX - 8,
    padY - 7 + bob,
    state.paddleX + PADDLE_WIDTH / 2,
    padY - 2 + bob,
  )
  ctx.stroke()

  const size = 64
  const img = assets.frong
  if (img) {
    ctx.drawImage(img, state.paddleX - size / 2, PADDLE_Y - size + 8 + bob, size, size)
  } else {
    const frogGradient = ctx.createRadialGradient(
      state.paddleX - 8,
      PADDLE_Y - 30 + bob,
      2,
      state.paddleX,
      PADDLE_Y - 22 + bob,
      25,
    )
    frogGradient.addColorStop(0, COLORS.accentBright)
    frogGradient.addColorStop(1, COLORS.accent)
    ctx.fillStyle = frogGradient
    ctx.beginPath()
    ctx.arc(state.paddleX, PADDLE_Y - 22 + bob, 24, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLORS.accentInk
    ctx.beginPath()
    ctx.arc(state.paddleX - 9, PADDLE_Y - 30 + bob, 4, 0, Math.PI * 2)
    ctx.arc(state.paddleX + 9, PADDLE_Y - 30 + bob, 4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Waterline + gentle ripples around the pad. */
function drawSurface(ctx: CanvasRenderingContext2D, state: GameState, reduced: boolean): void {
  const { fieldWidth: w, fieldHeight: h } = state.config
  ctx.strokeStyle = COLORS.waterLine
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h - 8)
  ctx.lineTo(w, h - 8)
  ctx.stroke()

  if (!reduced) {
    for (let i = 0; i < 2; i += 1) {
      const phase = (state.tick / 40 + i * 0.5) % 1
      ctx.globalAlpha = (1 - phase) * 0.22
      ctx.beginPath()
      ctx.ellipse(
        state.paddleX,
        h - 6,
        PADDLE_WIDTH / 2 + 20 + phase * 34,
        4 + phase * 5,
        0,
        0,
        Math.PI * 2,
      )
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
}

function drawFly(ctx: CanvasRenderingContext2D, fly: Fly, tick: number, reduced: boolean): void {
  const spec = FLY_TYPE_BY_ID[fly.type]
  const r = spec.radius
  ctx.save()
  ctx.translate(fly.x, fly.y)
  ctx.fillStyle = FLY_COLORS[fly.type]
  ctx.shadowColor = FLY_COLORS[fly.type]
  ctx.shadowBlur = reduced ? 0 : fly.type === 'queen' ? 12 : 5

  if (!reduced) {
    ctx.globalAlpha = 0.14
    ctx.strokeStyle = FLY_COLORS[fly.type]
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, -r * 1.5)
    ctx.lineTo(0, -r * 3.1)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  switch (fly.type) {
    case 'gnat': {
      // Round body with two fluttering wing ellipses.
      const flutter = reduced ? 1 : 1 + 0.18 * dsin(tick / 7 + fly.phase)
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.ellipse(-r * 0.7, -r * 0.5, r * 0.6, r * 0.35 * flutter, -0.5, 0, Math.PI * 2)
      ctx.ellipse(r * 0.7, -r * 0.5, r * 0.6, r * 0.35 * flutter, 0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'midge': {
      // Small elongated dart.
      ctx.beginPath()
      ctx.ellipse(0, 0, r * 0.45, r, 0, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'drifter': {
      // Circle with a contrasting stripe.
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = COLORS.waterBottom
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(-r * 0.7, 0)
      ctx.lineTo(r * 0.7, 0)
      ctx.stroke()
      break
    }
    case 'firefly': {
      // Glowing core — the one fly allowed extra flair.
      const glow = reduced ? 18 : 14 + 6 * dsin(tick / 12 + fly.phase)
      ctx.shadowColor = COLORS.firefly
      ctx.shadowBlur = glow
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.fillStyle = COLORS.accentInk
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'queen': {
      // Larger body with a three-point crown.
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(-r * 0.6, -r * 0.55)
      ctx.lineTo(-r * 0.35, -r * 1.05)
      ctx.lineTo(-r * 0.1, -r * 0.55)
      ctx.lineTo(r * 0.1, -r * 1.05)
      ctx.lineTo(r * 0.35, -r * 0.55)
      ctx.lineTo(r * 0.6, -r * 1.05)
      ctx.lineTo(r * 0.6, -r * 0.45)
      ctx.lineTo(-r * 0.6, -r * 0.45)
      ctx.closePath()
      ctx.fill()
      break
    }
  }
  ctx.shadowBlur = 0
  ctx.globalAlpha = 0.55
  ctx.fillStyle = COLORS.ink
  ctx.beginPath()
  ctx.arc(-r * 0.2, -r * 0.24, Math.max(0.7, r * 0.13), 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.restore()
}
