import { PinataSDK, type PinataConfig } from 'pinata'
import { existsSync, readFileSync } from 'node:fs'
import { isProductionLike, type ServerConfig } from './config'
import { writeMetadataFile } from './store'

export interface PinnedMetadata {
  /** Immutable URI engraved on-chain (ipfs://cid, or a local dev URL). */
  uri: string
  cid: string
}

/**
 * Commits trophy metadata to an immutable location. Implementations MUST
 * fail (throw) rather than return a fake CID - a trophy is only minted
 * against a URI the pinner actually produced.
 */
export interface MetadataPinner {
  pinMetadata(tokenId: number, metadata: unknown): Promise<PinnedMetadata>
  /**
   * Optional restart-recovery probe. A false result means the persisted URI
   * is not trusted for this pinner and metadata must be pinned again.
   */
  isPinned?(tokenId: number, uri: string, metadata: unknown): Promise<boolean>
}

/** Keys that must never appear in pinned metadata (least-privilege hygiene). */
const SECRET_KEY = /secret|password|private|mnemonic|jwt|api[-_]?key/i

/**
 * Immutable-metadata validation: plain JSON object, required fields, stable
 * JSON round-trip, and no secret-shaped keys anywhere in the tree.
 */
export function validateMetadata(metadata: unknown): void {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('metadata must be a JSON object')
  }
  const record = metadata as Record<string, unknown>
  for (const field of ['name', 'description', 'image', 'attributes']) {
    if (!(field in record)) throw new Error('metadata missing required field: ' + field)
    if (typeof record[field] !== 'string' && field !== 'attributes') {
      throw new Error('metadata field must be a string: ' + field)
    }
  }
  if (!Array.isArray(record.attributes)) throw new Error('metadata attributes must be an array')
  let canonical: string
  try {
    canonical = JSON.stringify(metadata)
  } catch {
    throw new Error('metadata is not JSON-serializable')
  }
  if (JSON.stringify(JSON.parse(canonical)) !== canonical) {
    throw new Error('metadata is not stable JSON')
  }
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((value, index) => walk(value, path + '[' + index + ']'))
      return
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (SECRET_KEY.test(key)) {
          throw new Error('metadata field looks like a secret: ' + path + '.' + key)
        }
        walk(value, path + '.' + key)
      }
    }
  }
  walk(metadata, 'metadata')
}

/**
 * Production pinner: Pinata (official SDK), JSON content, ipfs:// URI.
 * Requires PINATA_JWT; the gateway is optional and only used by the SDK.
 */
export class PinataPinner implements MetadataPinner {
  private readonly sdk: PinataSDK

  constructor(jwt: string, gateway: string | null, sdk?: PinataSDK) {
    if (!jwt) throw new Error('PINATA_JWT is required for the Pinata pinner')
    this.sdk =
      sdk ??
      new PinataSDK({ pinataJwt: jwt, pinataGateway: gateway ?? undefined } satisfies PinataConfig)
  }

  async pinMetadata(tokenId: number, metadata: unknown): Promise<PinnedMetadata> {
    validateMetadata(metadata)
    const upload = await this.sdk.upload.public.json(metadata as object, {
      metadata: { name: 'frong-catch-' + tokenId + '.json' },
    })
    const cid = String(upload.cid)
    return { uri: 'ipfs://' + cid, cid }
  }

  async isPinned(_tokenId: number, uri: string, _metadata: unknown): Promise<boolean> {
    // An IPFS CID is immutable and is the only URI shape this pinner emits.
    // Availability is checked by the gateway/marketplace, not by mint retry.
    void _tokenId
    void _metadata
    return uri.startsWith('ipfs://') && uri.length > 'ipfs://'.length
  }
}

/**
 * DEV/TEST ONLY: commits metadata to the local data dir and returns a
 * METADATA_BASE_URL URI. Never selected in production (the factory fails
 * closed there instead).
 */
export class LocalFilePinner implements MetadataPinner {
  private readonly normalizedBaseUrl: string

  constructor(
    private readonly dataDir: string,
    baseUrl: string,
  ) {
    this.normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
    if (!this.normalizedBaseUrl) throw new Error('METADATA_BASE_URL is required for local pinning')
  }

  async pinMetadata(tokenId: number, metadata: unknown): Promise<PinnedMetadata> {
    validateMetadata(metadata)
    writeMetadataFile(this.dataDir, tokenId, metadata)
    return {
      uri: this.normalizedBaseUrl + '/metadata/' + tokenId + '.json',
      cid: 'local:' + tokenId,
    }
  }

  async isPinned(tokenId: number, uri: string, metadata: unknown): Promise<boolean> {
    const expectedUri = this.normalizedBaseUrl + '/metadata/' + tokenId + '.json'
    if (uri !== expectedUri) return false
    const file = this.dataDir + '/metadata/' + tokenId + '.json'
    if (!existsSync(file)) return false
    try {
      validateMetadata(metadata)
      const stored = JSON.parse(readFileSync(file, 'utf8')) as unknown
      validateMetadata(stored)
      return JSON.stringify(stored) === JSON.stringify(metadata)
    } catch {
      return false
    }
  }
}

/** Fail-closed production pinner: refuses to invent a CID. */
export class FailingPinner implements MetadataPinner {
  async pinMetadata(_tokenId: number, _metadata: unknown): Promise<PinnedMetadata> {
    void _tokenId
    void _metadata
    throw new Error('metadata pinning is not configured (PINATA_JWT missing) - minting disabled')
  }

  async isPinned(_tokenId: number, _uri: string, _metadata: unknown): Promise<boolean> {
    void _tokenId
    void _uri
    void _metadata
    return false
  }
}

/**
 * Pinner factory: PINATA_JWT -> Pinata. Production-like config without it ->
 * failing (no mint can proceed). Dev/test without it -> local file pinner.
 */
export function createPinner(config: ServerConfig): MetadataPinner {
  if (config.pinataJwt) {
    return new PinataPinner(config.pinataJwt, config.pinataGateway)
  }
  if (isProductionLike(config)) return new FailingPinner()
  return new LocalFilePinner(config.dataDir, config.metadataBaseUrl)
}
