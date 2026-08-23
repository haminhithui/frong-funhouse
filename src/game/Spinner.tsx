import arcade from './arcade.module.css'

/**
 * Inline loading spinner. Purely decorative — screens that show it set
 * aria-busy and announce progress through the live region.
 */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className={arcade.spinnerRow}>
      <span className={arcade.spinner} aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  )
}
