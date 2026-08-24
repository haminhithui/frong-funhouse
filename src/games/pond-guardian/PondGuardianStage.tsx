import { useEffect, useRef } from 'react'
import { usePrefersReducedMotion } from '../../game/usePrefersReducedMotion'
import { consumeInput, createInputState, readGamepadInput, resetInputState } from './input'
import { renderGame } from './render'
import { createGame, resultForState, stepGame } from './sim/sim'
import { FIELD_HEIGHT, FIELD_WIDTH, TICKS_PER_SECOND } from './sim/constants'
import type { PondGuardianEvent, PondGuardianResult, PondGuardianState, Vec2 } from './sim/types'
import { TouchControls } from './TouchControls'
import styles from './pondGuardian.module.css'

export interface PondGuardianHudSnapshot {
  status: PondGuardianState['status']
  phase: PondGuardianState['phase']
  timeLeft: number
  score: number
  kills: number
  threats: number
  projectiles: number
  phaseProgress: number
  frogHealth: number
  frogMaxHealth: number
  playerHealth: number
  playerMaxHealth: number
}

interface PondGuardianStageProps {
  seed: number
  paused: boolean
  className?: string
  onHud: (hud: PondGuardianHudSnapshot) => void
  onEvent: (event: PondGuardianEvent) => void
  onFinish: (result: PondGuardianResult) => void
}

function logicalPointerPosition(event: PointerEvent, canvas: HTMLCanvasElement): Vec2 {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * FIELD_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * FIELD_HEIGHT,
  }
}

export function PondGuardianStage({
  seed,
  paused,
  className,
  onHud,
  onEvent,
  onFinish,
}: PondGuardianStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<PondGuardianState | null>(null)
  const inputRef = useRef(createInputState())
  const previousGamepadAttackRef = useRef(false)
  const lastEventIdRef = useRef(0)
  const callbacksRef = useRef({ onHud, onEvent, onFinish })
  callbacksRef.current = { onHud, onEvent, onFinish }
  const reducedMotion = usePrefersReducedMotion()
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      inputRef.current.pointerAim = logicalPointerPosition(event, canvas)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      inputRef.current.pointerAim = logicalPointerPosition(event, canvas)
      if (event.button === 0) inputRef.current.attackQueued = true
    }
    const onPointerLeave = () => {
      inputRef.current.pointerAim = null
    }
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerleave', onPointerLeave)
    return () => {
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [])

  useEffect(() => {
    const keys = inputRef.current.keyboard
    const setKey = (key: string, pressed: boolean): boolean => {
      if (key === 'w' || key === 'ArrowUp') keys.up = pressed
      else if (key === 's' || key === 'ArrowDown') keys.down = pressed
      else if (key === 'a' || key === 'ArrowLeft') keys.left = pressed
      else if (key === 'd' || key === 'ArrowRight') keys.right = pressed
      else return false
      return true
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (setKey(event.key, true) || event.key === ' ') {
        event.preventDefault()
        if (event.key === ' ') inputRef.current.attackQueued = true
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (setKey(event.key, false)) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    if (paused) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    if (stateRef.current === null) stateRef.current = createGame(seed)
    const state = stateRef.current
    ctx.imageSmoothingEnabled = true
    const stepMs = 1000 / TICKS_PER_SECOND
    let accumulator = 0
    let previousTime = performance.now()
    let frameId = 0

    const loop = (now: number) => {
      accumulator += Math.min(250, now - previousTime)
      previousTime = now

      const gamepad =
        typeof navigator.getGamepads === 'function' ? navigator.getGamepads()[0] : null
      const pad = readGamepadInput(gamepad)
      inputRef.current.gamepadMove = pad.move
      inputRef.current.gamepadAim = pad.aim
      if (pad.attackPressed && !previousGamepadAttackRef.current)
        inputRef.current.attackQueued = true
      previousGamepadAttackRef.current = pad.attackPressed

      while (accumulator >= stepMs && state.status === 'playing') {
        const frame = consumeInput(inputRef.current, state.player.position)
        stepGame(state, frame)
        accumulator -= stepMs
        if (state.lastEvent !== null && state.lastEvent.id !== lastEventIdRef.current) {
          lastEventIdRef.current = state.lastEvent.id
          callbacksRef.current.onEvent(state.lastEvent)
        }
      }

      renderGame(ctx, state, { reducedMotion: reducedMotionRef.current })
      callbacksRef.current.onHud({
        status: state.status,
        phase: state.phase,
        timeLeft: Math.max(
          0,
          Math.ceil((state.config.durationTicks - state.tick) / TICKS_PER_SECOND),
        ),
        score: state.score,
        kills: state.kills,
        threats: state.enemies.length,
        projectiles: state.projectiles.length,
        phaseProgress:
          ((state.tick % state.config.phaseDurationTicks) / state.config.phaseDurationTicks) * 100,
        frogHealth: state.frog.health,
        frogMaxHealth: state.frog.maxHealth,
        playerHealth: state.player.health,
        playerMaxHealth: state.player.maxHealth,
      })

      if (state.status !== 'playing') {
        callbacksRef.current.onFinish(resultForState(state))
        return
      }
      frameId = requestAnimationFrame(loop)
    }

    frameId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frameId)
  }, [paused, seed])

  const setTouchMove = (value: Vec2) => {
    inputRef.current.touchMove = value
  }
  const setTouchAim = (value: Vec2) => {
    inputRef.current.touchAim = value
  }
  const queueTouchAttack = () => {
    inputRef.current.attackQueued = true
  }

  useEffect(() => {
    if (!paused) return
    resetInputState(inputRef.current)
  }, [paused])

  return (
    <div className={className ?? styles.stage}>
      <canvas ref={canvasRef} width={FIELD_WIDTH} height={FIELD_HEIGHT} aria-hidden="true" />
      <TouchControls onMove={setTouchMove} onAim={setTouchAim} onAttack={queueTouchAttack} />
    </div>
  )
}
