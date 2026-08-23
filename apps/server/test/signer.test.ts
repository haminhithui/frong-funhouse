import { describe, expect, it } from 'vitest'
import { hashMessage, hexToBytes, recoverAddress } from 'viem'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { AwsKmsSigner, EnvKeySigner, createSigner } from '../src/signer'
import { testConfig } from './config'

describe('minter signers', () => {
  it('EnvKeySigner derives the account from the key or disables when absent', async () => {
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)
    const signer = new EnvKeySigner(key)
    expect(signer.address).toBe(account.address)
    expect((await signer.getAccount())?.address).toBe(account.address)
    expect(await new EnvKeySigner(null).getAccount()).toBeNull()
  })

  it('factory: complete KMS config wins and IGNORES plaintext MINTER_KEY', () => {
    const { signer, mode } = createSigner(
      testConfig({
        kmsRegion: 'us-east-1',
        kmsKeyId: 'key-1',
        kmsMinerAddress: '0x' + 'aa'.repeat(20),
        minterKey: '0x' + 'bb'.repeat(32),
      }),
    )
    expect(mode).toBe('kms')
    expect(signer).toBeInstanceOf(AwsKmsSigner)
    expect(signer.address).toBe('0x' + 'aa'.repeat(20))
  })

  it('factory: plaintext key allowed in dev, rejected in production, none otherwise', () => {
    expect(createSigner(testConfig({ minterKey: '0x' + 'cc'.repeat(32) })).mode).toBe('env')
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() => createSigner(testConfig({ minterKey: '0x' + 'cc'.repeat(32) }))).toThrow(
        'not allowed in production',
      )
    } finally {
      process.env.NODE_ENV = previous
    }
    expect(createSigner(testConfig()).mode).toBe('none')
  })

  it('requires KMS on mainnet even when NODE_ENV is unset', () => {
    expect(() =>
      createSigner(testConfig({ chainId: 4663, minterKey: '0x' + 'dd'.repeat(32) })),
    ).toThrow('mainnet 4663')
    expect(() => createSigner(testConfig({ chainId: 4663 }))).toThrow('requires KMS')
    expect(
      createSigner(
        testConfig({
          chainId: 4663,
          kmsRegion: 'us-east-1',
          kmsKeyId: 'key-1',
          kmsMinerAddress: '0x' + 'aa'.repeat(20),
        }),
      ).mode,
    ).toBe('kms')
  })

  it('rejects partial KMS configuration instead of silently falling back', () => {
    expect(() => createSigner(testConfig({ kmsRegion: 'us-east-1', kmsKeyId: 'key-1' }))).toThrow(
      'incomplete KMS configuration',
    )
  })

  it('AwsKmsSigner signs messages through KMS Sign and recovers to the configured address', async () => {
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)
    // Mock KMS client: signs the digest with the real local key (no AWS call).
    const fakeClient = {
      send: async (command: { input: { Message?: Uint8Array } }) => {
        const message = command.input.Message
        if (!message) throw new Error('no message')
        const hash = ('0x' + Buffer.from(message).toString('hex')) as Hex
        const signature = await account.sign({ hash })
        const raw = hexToBytes(signature)
        const order = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')
        const highS = order - BigInt('0x' + Buffer.from(raw.subarray(32, 64)).toString('hex'))
        const highSBytes = hexToBytes(('0x' + highS.toString(16).padStart(64, '0')) as Hex)
        return {
          Signature: new Uint8Array([...raw.subarray(0, 32), ...highSBytes]),
        }
      },
    }
    const signer = new AwsKmsSigner({
      region: 'us-east-1',
      keyId: 'key-1',
      address: account.address,
      client: fakeClient as never,
    })
    const acct = await signer.getAccount()
    if (!acct?.signMessage) throw new Error('expected a signing account')
    const signature = await acct.signMessage({ message: 'hello-frong' })
    const recovered = await recoverAddress({ hash: hashMessage('hello-frong'), signature })
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
    const serializedS = BigInt('0x' + signature.slice(66, 130))
    expect(serializedS).toBeLessThanOrEqual(
      BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0'),
    )
  })

  it('AwsKmsSigner surfaces KMS errors instead of swallowing them', async () => {
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)
    const fakeClient = {
      send: async () => {
        throw new Error('AccessDenied')
      },
    }
    const signer = new AwsKmsSigner({
      region: 'us-east-1',
      keyId: 'key-1',
      address: account.address,
      client: fakeClient as never,
    })
    const acct = await signer.getAccount()
    if (!acct?.signMessage) throw new Error('expected a signing account')
    await expect(acct.signMessage({ message: 'x' })).rejects.toThrow('AccessDenied')
  })
})
