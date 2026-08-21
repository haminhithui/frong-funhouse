/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Regression guards for the embed wrapper sizing bug: the official X widget
 * sizes its iframe to the wrapper width, so a wrapper wider than the 550px
 * official content produced a stretched iframe with a large blank area.
 */
const embedCss = readFileSync('src/components/XEmbedCard.module.css', 'utf8')
const featuredCss = readFileSync('src/components/FeaturedFromX.module.css', 'utf8')

describe('embed wrapper sizing (regression guards)', () => {
  it('caps the embed wrapper at the official 550px width and centers it', () => {
    expect(embedCss).toContain('max-width: 550px')
    expect(embedCss).toContain('margin-inline: auto')
  })

  it('keeps the featured card flush with the iframe (no inner padding)', () => {
    expect(embedCss).toContain('.cardFlush {')
    expect(embedCss).toContain('padding: 0;')
  })

  it('keeps the wall cards shell-less (no border, background, or radius)', () => {
    expect(embedCss).toContain('.cardBare {')
    expect(embedCss).toContain('background: none;')
    expect(embedCss).toContain('border: none;')
    expect(embedCss).toContain('border-radius: 0;')
  })

  it('shrinks the featured wrapper to the embed width so no blank space returns', () => {
    expect(featuredCss).toContain('max-width: 552px')
    expect(featuredCss).toContain('margin-inline: auto')
  })

  it('clips embed overflow inside the card frame', () => {
    expect(embedCss).toContain('overflow: hidden')
  })

  it('caps anything the widget injects inside the embed wrapper', () => {
    expect(embedCss).toContain('.embed > * {')
    expect(embedCss).toContain('max-width: 100% !important;')
  })
})
