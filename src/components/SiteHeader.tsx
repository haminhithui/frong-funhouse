import { useEffect, useState } from 'react'
import type { EcosystemLink, NavItem } from '../types/content'
import { FrongTile } from './FrongTile'
import styles from './SiteHeader.module.css'

interface SiteHeaderProps {
  name: string
  brandMarkSrc: string
  navItems: readonly NavItem[]
  externalLinks: readonly EcosystemLink[]
}

/** Desktop keeps one ruled masthead row; below it the same links fold into a
 *  single disclosure panel so nothing ever wraps into a second messy tier. */
const DESKTOP_QUERY = '(min-width: 920px)'

export function SiteHeader({ name, brandMarkSrc, navItems, externalLinks }: SiteHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  // Crossing back into the desktop row resets the panel state.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const desktop = window.matchMedia(DESKTOP_QUERY)
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false)
    }
    desktop.addEventListener('change', onChange)
    return () => desktop.removeEventListener('change', onChange)
  }, [])

  // Escape closes the panel from anywhere inside it.
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  return (
    <header className={styles.header}>
      <div className={`container ${styles.inner}`}>
        <a className={styles.brand} href="#top" aria-label={`${name} home`}>
          <FrongTile src={brandMarkSrc} alt="" size={34} className={styles.brandMark} />
          <span className={styles.brandName}>{name}</span>
        </a>

        <div id="site-header-menu" className={styles.menu} data-open={menuOpen}>
          <div className={styles.external}>
            {externalLinks.map((link) => (
              <a
                key={link.id}
                className={styles.externalLink}
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => setMenuOpen(false)}
              >
                {link.label} <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
          <nav aria-label="Main navigation" className={styles.nav}>
            {navItems.map((item) => (
              <a
                key={item.id}
                href={item.href}
                className={styles.navLink}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>

        <button
          type="button"
          className={styles.menuButton}
          aria-expanded={menuOpen}
          aria-controls="site-header-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className={styles.menuLabel}>{menuOpen ? 'Close' : 'Menu'}</span>
          <span className={styles.menuIcon} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
      </div>
    </header>
  )
}
