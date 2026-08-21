import { KMSClient, SignCommand } from '@aws-sdk/client-kms'
import {
  hashMessage,
  hexToBytes,
  keccak256,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  type Account,
  type Hex,
  type SignableMessage,
} from 'viem'
import { privateKeyToAccount, toAccount } from 'viem/accounts'
import type { ServerConfig } from './config'

/**
 * Mint-signing abstraction. The raw key material never leaves the signer:
 * EnvKeySigner is dev/testnet only, AwsKmsSigner signs digests inside KMS.
 */
export interface MinterSigner {
  /** Configured minter address (checks/display only). */
  readonly address: Hex | null
  /** Returns the viem account that signs mint transactions, or null when
   * signing is disabled (the mint queue then keeps records queued). */
  getAccount(): Promise<Account | null>
}

/** Local hot-key signer - DEV/TESTNET ONLY. Production must use KMS. */
export class EnvKeySigner implements MinterSigner {
  readonly address: Hex | null
  private readonly account: Account | null

  constructor(privateKey: string | null) {
    if (!privateKey) {
      this.address = null
      this.account = null
      return
    }
    const account = privateKeyToAccount(privateKey as Hex)
    this.account = account
    this.address = account.address
  }

  async getAccount(): Promise<Account | null> {
    return this.account
  }
}

interface KmsSignerOptions {
  region: string
  keyId: string
  address: Hex
  /** Injectable for tests; production uses the default regional client. */
  client?: KMSClient
}

/** A raw r||s signature with a resolved parity. */
interface RawSignature {
  r: Hex
  s: Hex
  yParity: 0 | 1
}

/**
 * AWS KMS-backed viem account (established viem custom-account pattern).
 * Signs only digests via KMS Sign (MessageType DIGEST, ECDSA_SHA_256) and
 * determines yParity by recovering against the configured minter address.
 * Never logs, persists, or otherwise exposes key material.
 */
export class AwsKmsSigner implements MinterSigner {
  readonly address: Hex
  private readonly account: Account

  constructor(options: KmsSignerOptions) {
    this.address = options.address.toLowerCase() as Hex
    const client = options.client ?? new KMSClient({ region: options.region })
    const keyId = options.keyId
    const address = this.address

    const signDigest = async (hash: Hex): Promise<RawSignature> => {
      const response = await client.send(
        new SignCommand({
          KeyId: keyId,
          Message: hexToBytes(hash) as Uint8Array,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      )
      const raw = response.Signature
      if (!raw || raw.length !== 64) {
        throw new Error('KMS returned an unexpected signature length')
      }
      const r = ('0x' + Buffer.from(raw.subarray(0, 32)).toString('hex')) as Hex
      const s = ('0x' + Buffer.from(raw.subarray(32)).toString('hex')) as Hex
      for (const yParity of [0, 1] as const) {
        try {
          const recovered = await recoverAddress({ hash, signature: { r, s, yParity } })
          if (recovered.toLowerCase() === address) {
            return { r, s, yParity }
          }
        } catch {
          // Wrong parity - try the other one.
        }
      }
      throw new Error('KMS signature does not recover to the configured minter address')
    }

    const toSignatureHex = (signature: RawSignature): Hex =>
      serializeSignature({ r: signature.r, s: signature.s, yParity: signature.yParity })

    this.account = toAccount({
      address,
      async signMessage({ message }: { message: SignableMessage }) {
        return toSignatureHex(await signDigest(hashMessage(message)))
      },
      async signTransaction(transaction) {
        const signature = await signDigest(keccak256(serializeTransaction(transaction)))
        return serializeTransaction(transaction, {
          r: signature.r,
          s: signature.s,
          yParity: signature.yParity,
        })
      },
      async signTypedData() {
        throw new Error('KMS signer does not sign typed data')
      },
    })
  }

  async getAccount(): Promise<Account> {
    return this.account
  }
}

export type SignerMode = 'kms' | 'env' | 'none'

/**
 * Signer factory: complete KMS config -> KMS (plaintext MINTER_KEY is
 * IGNORED in that case). Plaintext key only for non-production dev/testnet.
 * Production with a plaintext key and no KMS FAILS CLOSED (throws).
 */
export function createSigner(config: ServerConfig): { signer: MinterSigner; mode: SignerMode } {
  const kmsReady = Boolean(config.kmsRegion && config.kmsKeyId && config.kmsMinerAddress)
  if (kmsReady) {
    return {
      signer: new AwsKmsSigner({
        region: config.kmsRegion as string,
        keyId: config.kmsKeyId as string,
        address: config.kmsMinerAddress as Hex,
      }),
      mode: 'kms',
    }
  }
  if (config.minterKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'MINTER_KEY is not allowed in production - configure KMS_REGION/KMS_KEY_ID/KMS_MINTER_ADDRESS instead',
      )
    }
    return { signer: new EnvKeySigner(config.minterKey), mode: 'env' }
  }
  return { signer: new EnvKeySigner(null), mode: 'none' }
}

/** Boot-safe wrapper: signer misconfiguration disables minting, never crashes boot. */
export function createSignerSafe(config: ServerConfig): { signer: MinterSigner; mode: SignerMode } {
  try {
    return createSigner(config)
  } catch (error) {
    console.error('[signer]', String(error), '- minting disabled')
    return { signer: new EnvKeySigner(null), mode: 'none' }
  }
}
