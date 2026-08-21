interface FrongTileProps {
  src: string
  alt: string
  size?: number
  className?: string
}

/**
 * The single identity frame used everywhere the FRONG PNG appears.
 * Square token-tile treatment with a thin accent ring — no stretching,
 * no raw letterboxing.
 */
export function FrongTile({ src, alt, size, className }: FrongTileProps) {
  return (
    <span
      className={'frong-tile' + (className ? ' ' + className : '')}
      style={size ? { width: size, height: size } : undefined}
    >
      <img src={src} alt={alt} className="frong-tile-img" />
    </span>
  )
}
