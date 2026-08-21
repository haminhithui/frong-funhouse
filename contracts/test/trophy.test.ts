import { expect } from 'chai'
import hre from 'hardhat'
import { getAddress, stringToHex, zeroAddress, zeroHash } from 'viem'
import { expectRevert } from './helpers'

const URI = 'ipfs://bafy-test-metadata'

function attestation(
  overrides: Partial<{
    tier: number
    score: number
    flies: number
    seedCommitment: string
    inputLogHash: string
  }> = {},
) {
  return {
    tier: overrides.tier ?? 4,
    score: overrides.score ?? 85,
    fliesCaught: overrides.flies ?? 40,
    seedCommitment: overrides.seedCommitment ?? stringToHex('seed-1', { size: 32 }),
    inputLogHash: overrides.inputLogHash ?? stringToHex('log-1', { size: 32 }),
    timestamp: 1_700_000_000n,
    buildHash: stringToHex('build-1', { size: 32 }),
  }
}

describe('FrongTrophy (ERC-721, minter-only)', () => {
  async function deploy(soulbound = true) {
    const [deployer, minter, player, other] = await hre.viem.getWalletClients()
    const trophy = await hre.viem.deployContract('FrongTrophy', [soulbound])
    const trophyC = await hre.viem.getContractAt('FrongTrophy', trophy.address)
    await trophyC.write.setMinter([minter.account.address, true], { account: deployer.account })
    return { deployer, minter, player, other, trophy: trophyC }
  }

  it('lets only the minter mint, and records the attestation + URI', async () => {
    const { minter, player, trophy } = await deploy()
    const a = attestation()

    await expectRevert(
      trophy.write.mint([player.account.address, 1n, a, URI], { account: player.account }),
      'not minter',
    )
    await trophy.write.mint([player.account.address, 1n, a, URI], { account: minter.account })

    expect(await trophy.read.ownerOf([1n])).to.equal(getAddress(player.account.address))
    const stored = (await trophy.read.attestationOf([1n])) as {
      tier: number
      score: number
      fliesCaught: number
      seedCommitment: string
      buildHash: string
    }
    expect(stored.tier).to.equal(4)
    expect(stored.score).to.equal(85)
    expect(stored.fliesCaught).to.equal(40)
    expect(stored.seedCommitment).to.equal(a.seedCommitment)
    expect(stored.buildHash).to.equal(a.buildHash)
    expect(await trophy.read.tokenURI([1n])).to.equal(URI)

    const events = await trophy.getEvents.TrophyMinted()
    expect(events).to.have.length(1)
    const args = events[0].args as {
      to?: string
      tokenId?: bigint
      attestation?: { score: number }
      tokenURI_?: string
    }
    expect(args.to?.toLowerCase()).to.equal(player.account.address.toLowerCase())
    expect(args.tokenId).to.equal(1n)
    expect(args.attestation?.score).to.equal(85)
    expect(args.tokenURI_).to.equal(URI)
  })

  it('rejects a duplicate token id', async () => {
    const { minter, player, trophy } = await deploy()
    const a = attestation()
    await trophy.write.mint([player.account.address, 7n, a, URI], { account: minter.account })
    await expectRevert(
      trophy.write.mint([player.account.address, 7n, a, URI], { account: minter.account }),
      'ERC721InvalidSender',
    )
  })

  it('trips the rate cap and recovers after the window', async () => {
    const { minter, player, trophy } = await deploy()
    await trophy.write.setRateCap([2n], { account: (await hre.viem.getWalletClients())[0].account })
    const a = attestation()
    await trophy.write.mint([player.account.address, 1n, a, URI], { account: minter.account })
    await trophy.write.mint([player.account.address, 2n, a, URI], { account: minter.account })
    await expectRevert(
      trophy.write.mint([player.account.address, 3n, a, URI], { account: minter.account }),
      'rate cap',
    )
    await hre.network.provider.send('evm_increaseTime', [3700])
    await hre.network.provider.send('evm_mine')
    await trophy.write.mint([player.account.address, 3n, a, URI], { account: minter.account })
    expect(await trophy.read.ownerOf([3n])).to.equal(getAddress(player.account.address))
  })

  it('blocks mints while paused and after minter revocation', async () => {
    const { deployer, minter, player, trophy } = await deploy()
    const a = attestation()
    await trophy.write.pause({ account: deployer.account } as never)
    await expectRevert(
      trophy.write.mint([player.account.address, 1n, a, URI], { account: minter.account }),
      'EnforcedPause',
    )
    await trophy.write.unpause({ account: deployer.account } as never)
    await trophy.write.setMinter([minter.account.address, false], { account: deployer.account })
    await expectRevert(
      trophy.write.mint([player.account.address, 1n, a, URI], { account: minter.account }),
      'not minter',
    )
  })

  it('keeps admin actions (pause, setMinter, setRateCap) admin-only', async () => {
    const { minter, player, trophy } = await deploy()
    const a = attestation()
    await expectRevert(
      trophy.write.setMinter([player.account.address, true], { account: minter.account }),
      'not admin',
    )
    // pause() takes no contract args; the options object needs a cast on
    // hardhat-viem's zero-arg write typing.
    await expectRevert(trophy.write.pause({ account: minter.account } as never), 'not admin')
    await expectRevert(trophy.write.setRateCap([1n], { account: minter.account }), 'not admin')
    await expectRevert(
      trophy.write.mint([player.account.address, 1n, a, URI], { account: player.account }),
      'not minter',
    )
  })

  it('blocks transfers when soulbound and allows them when not', async () => {
    const soul = await deploy(true)
    await soul.trophy.write.mint([soul.player.account.address, 1n, attestation(), URI], {
      account: soul.minter.account,
    })
    await expectRevert(
      soul.trophy.write.transferFrom(
        [soul.player.account.address, soul.other.account.address, 1n],
        { account: soul.player.account },
      ),
      'soulbound',
    )

    const free = await deploy(false)
    await free.trophy.write.mint([free.player.account.address, 1n, attestation(), URI], {
      account: free.minter.account,
    })
    await free.trophy.write.transferFrom(
      [free.player.account.address, free.other.account.address, 1n],
      { account: free.player.account },
    )
    expect(await free.trophy.read.ownerOf([1n])).to.equal(getAddress(free.other.account.address))
  })

  it('D1: free-transfer trophies keep full approve and safeTransferFrom semantics', async () => {
    const free = await deploy(false)
    await free.trophy.write.mint([free.player.account.address, 1n, attestation(), URI], {
      account: free.minter.account,
    })
    // approve + safeTransferFrom both work - no fee, no restriction, no royalty hook.
    await free.trophy.write.approve([free.other.account.address, 1n], {
      account: free.player.account,
    })
    expect(await free.trophy.read.getApproved([1n])).to.equal(
      getAddress(free.other.account.address),
    )
    // The approved operator transfers from the owner - plain ERC-721 semantics.
    await free.trophy.write.safeTransferFrom(
      [free.player.account.address, free.other.account.address, 1n],
      { account: free.other.account },
    )
    expect(await free.trophy.read.ownerOf([1n])).to.equal(getAddress(free.other.account.address))
    // No royalty interface is exposed (D1 rules out EIP-2981 here).
    expect(await free.trophy.read.supportsInterface(['0x2a55205a'])).to.equal(false)
  })

  it('transfers admin via 2-step propose/accept with a 24h timelock', async () => {
    const { deployer, minter, trophy } = await deploy()
    await expectRevert(
      trophy.write.proposeAdmin([minter.account.address], { account: minter.account }),
      'not admin',
    )
    await expectRevert(
      trophy.write.proposeAdmin([zeroAddress], { account: deployer.account }),
      'zero admin',
    )
    await trophy.write.proposeAdmin([minter.account.address], { account: deployer.account })
    // Only the pending admin can accept, and only after the timelock.
    await expectRevert(
      trophy.write.acceptAdmin({ account: deployer.account } as never),
      'not pending admin',
    )
    await expectRevert(
      trophy.write.acceptAdmin({ account: minter.account } as never),
      'admin timelock',
    )
    await hre.network.provider.send('evm_increaseTime', [24 * 60 * 60 + 1])
    await hre.network.provider.send('evm_mine')
    await trophy.write.acceptAdmin({ account: minter.account } as never)
    expect(await trophy.read.admin()).to.equal(getAddress(minter.account.address))
    // The previous admin can no longer act.
    await expectRevert(trophy.write.setRateCap([1n], { account: deployer.account }), 'not admin')
  })

  it('rejects attestations outside the game bounds', async () => {
    const { minter, player, trophy } = await deploy()
    const cases: Array<[ReturnType<typeof attestation>, string]> = [
      [attestation({ score: 110 }), 'score bounds'],
      [attestation({ flies: 46 }), 'flies bounds'],
      [attestation({ tier: 6 }), 'tier bounds'],
      [attestation({ seedCommitment: zeroHash }), 'seed commitment'],
      [attestation({ inputLogHash: zeroHash }), 'input log hash'],
    ]
    for (let i = 0; i < cases.length; i++) {
      const [a, msg] = cases[i]
      await expectRevert(
        trophy.write.mint([player.account.address, BigInt(i + 1), a, URI], {
          account: minter.account,
        }),
        msg,
      )
    }
  })

  it('accepts attestations at the exact bounds', async () => {
    const { minter, player, trophy } = await deploy()
    const a = attestation({ score: 109, flies: 45, tier: 5 })
    await trophy.write.mint([player.account.address, 1n, a, URI], { account: minter.account })
    const stored = (await trophy.read.attestationOf([1n])) as {
      score: number
      fliesCaught: number
      tier: number
    }
    expect(stored.score).to.equal(109)
    expect(stored.fliesCaught).to.equal(45)
    expect(stored.tier).to.equal(5)
  })
})
