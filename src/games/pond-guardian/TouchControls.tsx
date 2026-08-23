import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Vec2 } from './sim/types'
import styles from './pondGuardian.module.css'

interface StickProps {
  label: string
  onChange: (value: Vec2) => void
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value))
}

function Stick({ label, onChange }: StickProps) {
  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const radius = Math.min(rect.width, rect.height) / 2
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    onChange({
      x: clamp((event.clientX - centerX) / radius),
      y: clamp((event.clientY - centerY) / radius),
    })
  }

  const reset = (event: ReactPointerEvent<HTMLDivElement>) => {
    onChange({ x: 0, y: 0 })
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div
      className={styles.stick}
      aria-hidden="true"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        update(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event)
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
      onPointerLeave={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event)
      }}
    >
      <span className={styles.stickRing} />
      <span className={styles.stickLabel}>{label}</span>
    </div>
  )
}

export function TouchControls({
  onMove,
  onAim,
  onAttack,
}: {
  onMove: (value: Vec2) => void
  onAim: (value: Vec2) => void
  onAttack: () => void
}) {
  return (
    <div className={styles.touchControls} aria-label="Touch controls">
      <Stick label="Move" onChange={onMove} />
      <button type="button" className={styles.attackButton} aria-label="Attack" onClick={onAttack}>
        Axe
      </button>
      <Stick label="Aim" onChange={onAim} />
    </div>
  )
}
