import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { issueChallenge, verifyChallenge } from '../src/challenge'

describe('wallet verification challenge (SIWE-style)', () => {
  const player = privateKeyToAccount(
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  )
  const imposter = privateKeyToAccount(
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  )

  it('verifies a real signature over the exact challenge message', async () => {
    const challenge = issueChallenge(player.address, 31337)
    expect(challenge.message).toContain(player.address)
    expect(challenge.message).toContain(challenge.nonce)

    const signature = await player.signMessage({ message: challenge.message })
    const recovered = await verifyChallenge(player.address, challenge.nonce, signature)
    expect(recovered?.toLowerCase()).toBe(player.address.toLowerCase())
  })

  it('rejects a signature from a different wallet', async () => {
    const challenge = issueChallenge(player.address, 31337)
    const signature = await imposter.signMessage({ message: challenge.message })
    expect(await verifyChallenge(player.address, challenge.nonce, signature)).toBeNull()
  })

  it('rejects a signature over a different message', async () => {
    const challenge = issueChallenge(player.address, 31337)
    const signature = await player.signMessage({ message: 'some other message' })
    expect(await verifyChallenge(player.address, challenge.nonce, signature)).toBeNull()
  })

  it('makes nonces single-use', async () => {
    const challenge = issueChallenge(player.address, 31337)
    const signature = await player.signMessage({ message: challenge.message })
    expect(await verifyChallenge(player.address, challenge.nonce, signature)).not.toBeNull()
    expect(await verifyChallenge(player.address, challenge.nonce, signature)).toBeNull()
  })

  it('rejects unknown nonces and mismatched addresses', async () => {
    expect(await verifyChallenge(player.address, 'deadbeef', '0x00')).toBeNull()
    const challenge = issueChallenge(player.address, 31337)
    const signature = await player.signMessage({ message: challenge.message })
    expect(await verifyChallenge(imposter.address, challenge.nonce, signature)).toBeNull()
  })
})
