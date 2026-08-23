import { FLY_COLORS } from './render'
import type { FlyTypeId } from './sim/types'

/** Small inline glyph per fly type — matches the canvas silhouettes (shape, never color alone). */
export function FlyGlyph({ type }: { type: FlyTypeId }) {
  const color = FLY_COLORS[type]
  switch (type) {
    case 'gnat':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <ellipse
            cx="8.5"
            cy="11"
            rx="4.5"
            ry="2.6"
            transform="rotate(-28 8.5 11)"
            fill={color}
            opacity="0.55"
          />
          <ellipse
            cx="19.5"
            cy="11"
            rx="4.5"
            ry="2.6"
            transform="rotate(28 19.5 11)"
            fill={color}
            opacity="0.55"
          />
          <circle cx="14" cy="15.5" r="5.4" fill={color} />
        </svg>
      )
    case 'midge':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <ellipse cx="14" cy="14" rx="3.6" ry="8" fill={color} />
        </svg>
      )
    case 'drifter':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <circle cx="14" cy="14" r="7" fill={color} />
          <rect x="7" y="12.6" width="14" height="2.8" rx="1.4" fill="#0b0d0c" />
        </svg>
      )
    case 'firefly':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <circle cx="14" cy="14" r="7.4" fill={color} opacity="0.35" />
          <circle cx="14" cy="14" r="5" fill={color} />
          <circle cx="14" cy="14" r="2.2" fill="#101a08" />
        </svg>
      )
    case 'queen':
      return (
        <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
          <circle cx="14" cy="16" r="6.4" fill={color} />
          <path
            d="M8.6 13.9 L10.7 7.8 L12.8 13.9 L14.9 7.8 L17 13.9 L19.1 7.8 L21 13.6 L21 15.6 L8.6 15.6 Z"
            fill={color}
          />
        </svg>
      )
  }
}
