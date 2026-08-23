import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { testConfig } from './config'
import {
  createPinner,
  FailingPinner,
  LocalFilePinner,
  PinataPinner,
  validateMetadata,
} from '../src/pinner'

function validMetadata() {
  return {
    name: 'FRONG Catch Trophy #1 — Tadpole',
    description: 'Replay-verified run: 20/109 points.',
    image: 'https://gateway.example/assets/tiers/tadpole.svg',
    attributes: [{ trait_type: 'Tier', value: 'Tadpole' }],
  }
}

describe('metadata pinner', () => {
  it('validates immutable metadata: rejects non-objects, missing fields, and secret keys', () => {
    expect(() => validateMetadata(null)).toThrow('JSON object')
    expect(() => validateMetadata([])).toThrow('JSON object')
    expect(() => validateMetadata({ name: 'x' })).toThrow('missing required field')
    expect(() => validateMetadata({ ...validMetadata(), apiKey: 'secret' })).toThrow('secret')
    expect(() =>
      validateMetadata({
        ...validMetadata(),
        attributes: [{ trait_type: 'Tier', value: 'Tadpole', password: 'x' }],
      }),
    ).toThrow('secret')
    expect(() => validateMetadata(validMetadata())).not.toThrow()
  })

  it('FailingPinner never invents a CID', async () => {
    await expect(new FailingPinner().pinMetadata(1, validMetadata())).rejects.toThrow(
      'PINATA_JWT missing',
    )
  })

  it('LocalFilePinner writes the metadata file and returns a local URI', async () => {
    const config = testConfig()
    const pinner = new LocalFilePinner(config.dataDir, config.metadataBaseUrl)
    const pinned = await pinner.pinMetadata(3, validMetadata())
    expect(pinned.uri).toBe(config.metadataBaseUrl + '/metadata/3.json')
    const file = join(config.dataDir, 'metadata', '3.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).name).toContain('Trophy')
    expect(await pinner.isPinned?.(3, pinned.uri, validMetadata())).toBe(true)
    expect(await pinner.isPinned?.(4, pinned.uri, validMetadata())).toBe(false)
  })

  it('PinataPinner pins JSON through the official SDK and returns ipfs:// URIs', async () => {
    const fakeSdk = {
      upload: {
        public: { json: async () => ({ cid: 'bafybeig-test' }) },
      },
    }
    const pinner = new PinataPinner('jwt-test', 'gateway.example', fakeSdk as never)
    const pinned = await pinner.pinMetadata(7, validMetadata())
    expect(pinned.uri).toBe('ipfs://bafybeig-test')
    expect(pinned.cid).toBe('bafybeig-test')
    // Validation still runs before any upload.
    await expect(pinner.pinMetadata(8, { ...validMetadata(), apiKey: 'x' })).rejects.toThrow(
      'secret',
    )
  })

  it('PinataPinner requires a JWT', () => {
    expect(() => new PinataPinner('', null)).toThrow('PINATA_JWT')
  })

  it('factory: PINATA_JWT -> Pinata; production without it -> failing; dev -> local', () => {
    expect(createPinner(testConfig({ pinataJwt: 'jwt-test' }))).toBeInstanceOf(PinataPinner)
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(createPinner(testConfig())).toBeInstanceOf(FailingPinner)
    } finally {
      process.env.NODE_ENV = previous
    }
    expect(createPinner(testConfig())).toBeInstanceOf(LocalFilePinner)
  })

  it('fails closed for mainnet even when NODE_ENV is omitted', () => {
    const previous = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      expect(createPinner(testConfig({ chainId: 4663, metadataBaseUrl: '' }))).toBeInstanceOf(
        FailingPinner,
      )
    } finally {
      process.env.NODE_ENV = previous
    }
  })
})
