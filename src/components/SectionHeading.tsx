interface SectionHeadingProps {
  eyebrow: string
  title: string
  lede?: string
  /** Optional id for the title heading (e.g. to label an embedded panel). */
  titleId?: string
}

export function SectionHeading({ eyebrow, title, lede, titleId }: SectionHeadingProps) {
  return (
    <header>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="section-title" id={titleId}>
        {title}
      </h2>
      {lede ? <p className="section-lede">{lede}</p> : null}
    </header>
  )
}
