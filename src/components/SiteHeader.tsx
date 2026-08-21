import type { EcosystemLink, NavItem } from '../types/content'
import { FrongTile } from './FrongTile'
import styles from './SiteHeader.module.css'

interface SiteHeaderProps {
  name: string
  brandMarkSrc: string
  navItems: readonly NavItem[]
  externalLinks: readonly EcosystemLink[]
}

export function SiteHeader({ name, brandMarkSrc, navItems, externalLinks }: SiteHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={`container ${styles.inner}`}>
        <a className={styles.brand} href="#top" aria-label={`${name} home`}>
          <FrongTile src={brandMarkSrc} alt="" size={34} className={styles.brandMark} />
          <span className={styles.brandName}>{name}</span>
        </a>
        <div className={styles.right}>
          <div className={styles.external}>
            {externalLinks.map((link) => (
              <a
                key={link.id}
                className={styles.externalLink}
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {link.label} <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
          <nav aria-label="Main navigation" className={styles.nav}>
            {navItems.map((item) => (
              <a key={item.id} href={item.href} className={styles.navLink}>
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </header>
  )
}
