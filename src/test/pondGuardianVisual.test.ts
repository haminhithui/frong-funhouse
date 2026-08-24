import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIELD_HEIGHT, FIELD_WIDTH, FROG_POSITION } from '../games/pond-guardian/sim/constants'

interface PondGuardianAssetManifest {
  references: { shipped: boolean }[]
  assets: { id: string; path: string; status: string }[]
}

describe('Pond Guardian visual contract', () => {
  it('keeps the protected frog at the exact center of the 4:3 arena', () => {
    expect(FROG_POSITION).toEqual({ x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2 })
  })

  it('ships the approved hero while keeping both moodboards out of the product', () => {
    const manifestPath = resolve(process.cwd(), 'docs/pond-guardian-asset-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PondGuardianAssetManifest
    const hero = manifest.assets.find((asset) => asset.id === 'pond-guardian-hero-3d-v1')

    expect(manifest.references).toHaveLength(2)
    expect(manifest.references.every((reference) => reference.shipped === false)).toBe(true)
    expect(hero?.status).toBe('approved visual target and integrated')
    expect(existsSync(resolve(process.cwd(), hero?.path ?? 'missing-hero'))).toBe(true)
  })
})
