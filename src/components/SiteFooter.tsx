import type { FooterConfig } from '../types/content'
import { FrongTile } from './FrongTile'
import styles from './SiteFooter.module.css'

export function SiteFooter({ footer }: { footer: FooterConfig }) {
  const year = new Date().getFullYear()
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.inner}`}>
        <div>
          <p className={styles.taglineRow}>
            <FrongTile src={footer.tileSrc} alt="" size={20} />
            <span className={styles.tagline}>{footer.tagline}</span>
          </p>
          <p className={styles.copy}>
            © {year} {footer.copyright}
          </p>
        </div>
        <p className={styles.disclaimer}>{footer.disclaimer}</p>
      </div>
    </footer>
  )
}
