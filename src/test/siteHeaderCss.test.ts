/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Regression guards for the header's touch targets and keyboard affordances.
 */
const headerCss = readFileSync('src/components/SiteHeader.module.css', 'utf8')

describe('site header (regression guards)', () => {
  it('keeps external links at the 44px touch target on mobile', () => {
    expect(headerCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.externalLink \{\s*\/\* 12px[\s\S]*?padding: 12px 0;\s*\}/,
    )
  })

  it('mirrors the nav underline on keyboard focus', () => {
    expect(headerCss).toContain('.navLink:focus-visible::after')
    expect(headerCss).toMatch(
      /\.navLink:hover::after,[\s\S]*?\.navLink:focus-visible::after \{\s*right: 0;\s*\}/,
    )
  })
})
