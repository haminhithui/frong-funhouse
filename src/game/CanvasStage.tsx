import { useEffect, useRef } from 'react'
import { renderGame } from './render'
import { FIELD_HEIGHT, FIELD_WIDTH, TICKS_PER_SECOND } from './sim/constants'
import { createGame, stepGame } from './sim/sim'
import type { GamePhase, GameState, InputFrame } from './sim/types'

export type { InputFrame }

export interface HudSnapshot {
  phase: GamePhase
  countdownLeft: number
  score: number
  caught: number
  timeLeft: number
}

export interface RunResult {
  score: number
  caught: number
  missed: number
}

interface CanvasStageProps {
  seed: number
  durationTicks?: number
  countdownTicks?: number
  paused: boolean
  reducedMotion: boolean
  /** Optional class for the stage wrapper (CSS Modules pass-through). */
  className?: string
  onHud: (hud: HudSnapshot) => void
  /** Receives the full per-tick input log — the replay-verification primitive. */
  onFinish: (result: RunResult, inputLog: InputFrame[]) => void
}

/**
 * Owns the fixed-timestep game loop for one run: rAF drives wall-clock time, the
 * sim advances in exact 1/60s steps, and every input frame is recorded into the
 * run's input log (the replay-verification primitive). The canvas is presentation
 * only; all state lives in the DOM HUD for assistive tech.
 */
export function CanvasStage({
  seed,
  durationTicks,
  countdownTicks,
  paused,
  reducedMotion,
  className,
  onHud,
  onFinish,
}: CanvasStageProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<GameState | null>(null)
  const inputRef = useRef<InputFrame>({ targetX: null, axis: 0 })
  const logRef = useRef<InputFrame[]>([])
  const frongRef = useRef<HTMLImageElement | null>(null)

  const callbacksRef = useRef({ onHud, onFinish })
  callbacksRef.current = { onHud, onFinish }
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion

  // Catcher art; the renderer falls back to a drawn frog if this fails.
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      frongRef.current = img
    }
    img.onerror = () => {
      frongRef.current = null
    }
    img.src = '/assets/avatar.png'
  }, [])

  // Pointer input: move the lily pad toward the pointer's field-x position.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onPointer = (event: PointerEvent) => {
      const rect = wrap.getBoundingClientRect()
      if (rect.width <= 0) return
      const targetX = ((event.clientX - rect.left) / rect.width) * FIELD_WIDTH
      inputRef.current = { targetX, axis: 0 }
    }
    wrap.addEventListener('pointerdown', onPointer)
    wrap.addEventListener('pointermove', onPointer)
    return () => {
      wrap.removeEventListener('pointerdown', onPointer)
      wrap.removeEventListener('pointermove', onPointer)
    }
  }, [])

  // Keyboard input: arrows take over from the pointer until released.
  useEffect(() => {
    const keys = { left: false, right: false }
    const apply = () => {
      const axis = keys.right ? 1 : keys.left ? -1 : 0
      inputRef.current = { targetX: null, axis: axis as -1 | 0 | 1 }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        keys.left = true
        apply()
        event.preventDefault()
      } else if (event.key === 'ArrowRight') {
        keys.right = true
        apply()
        event.preventDefault()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        keys.left = false
        apply()
      } else if (event.key === 'ArrowRight') {
        keys.right = false
        apply()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // The loop. Pausing cancels rAF but preserves sim state; resuming continues.
  useEffect(() => {
    if (paused) return
    if (!stateRef.current) {
      stateRef.current = createGame(seed, { durationTicks, countdownTicks })
      logRef.current = []
    }
    const state = stateRef.current
    const canvas = canvasRef.current
    const ctx = canvas ? canvas.getContext('2d') : null

    const stepMs = 1000 / TICKS_PER_SECOND
    let raf = 0
    let acc = 0
    let last = performance.now()

    const loop = (now: number) => {
      acc += now - last
      last = now
      if (acc > 250) acc = 250
      while (acc >= stepMs) {
        // Record a copy per tick: inputRef.current is mutated by input events.
        logRef.current.push({ ...inputRef.current })
        stepGame(state, inputRef.current)
        acc -= stepMs
      }
      if (ctx) {
        renderGame(
          ctx,
          state,
          { frong: frongRef.current },
          { reducedMotion: reducedMotionRef.current },
        )
      }
      callbacksRef.current.onHud({
        phase: state.phase,
        countdownLeft: state.countdownLeft,
        score: state.score,
        caught: state.caught,
        timeLeft: Math.max(
          0,
          Math.ceil((state.config.durationTicks - state.tick) / TICKS_PER_SECOND),
        ),
      })
      if (state.phase === 'finished') {
        callbacksRef.current.onFinish(
          {
            score: state.score,
            caught: state.caught,
            missed: state.missed,
          },
          logRef.current,
        )
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [paused, seed, durationTicks, countdownTicks])

  return (
    <div ref={wrapRef} className={className}>
      <canvas ref={canvasRef} width={FIELD_WIDTH} height={FIELD_HEIGHT} aria-hidden="true" />
    </div>
  )
}
