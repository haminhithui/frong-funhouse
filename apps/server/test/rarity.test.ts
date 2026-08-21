import { describe, expect, it } from 'vitest'
import { buildMetadata, seedCommitment, tierForVerifiedScore } from '../src/rarity'
import { testConfig } from './config'

describe('backend-decided rarity (skill-gated, no randomness)', () => {
  it('maps verified scores to the six design tiers', () => {
    expect(tierForVerifiedScore(0).slug).toBe('tadpole')
    expect(tierForVerifiedScore(19).slug).toBe('tadpole')
    expect(tierForVerifiedScore(20).slug).toBe('pond-hopper')
    expect(tierForVerifiedScore(40).slug).toBe('fly-snatcher')
    expect(tierForVerifiedScore(60).slug).toBe('lily-legend')
    expect(tierForVerifiedScore(80).slug).toBe('just-frong')
    expect(tierForVerifiedScore(109).slug).toBe('not-wrong')
    expect(tierForVerifiedScore(109).name).toBe('Not Wrong.')
  })

  it('derives a deterministic seed commitment', () => {
    expect(seedCommitment(12345)).toBe(seedCommitment(12345))
    expect(seedCommitment(12345)).not.toBe(seedCommitment(12346))
    expect(seedCommitment(12345)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('builds per-token metadata with the engraved verified stats', () => {
    const config = testConfig()
    const tier = tierForVerifiedScore(85)
    const { json, uri } = buildMetadata(config, 7, tier, 85, 40, seedCommitment(1))
    expect(json.name).toContain('#7')
    expect(json.name).toContain('Just FRONG.')
    expect(json.description).toContain('85/109')
    expect(json.attributes.find((a) => a.trait_type === 'Score')?.value).toBe(85)
    expect(json.attributes.find((a) => a.trait_type === 'Tier')?.value).toBe('Just FRONG.')
    expect(uri).toBe(config.metadataBaseUrl + '/metadata/7.json')
    expect(json.image).toBe(config.metadataBaseUrl + '/assets/tiers/just-frong.png')
  })
})
