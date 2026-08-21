import { expect } from 'chai'
import hre from 'hardhat'
import { expectRevert } from './helpers'

describe('MockFRONG (testnet faucet token)', () => {
  async function deploy() {
    const [deployer, player] = await hre.viem.getWalletClients()
    const frong = await hre.viem.deployContract('MockFRONG')
    return { deployer, player, frong }
  }

  it('has the expected metadata and 18 decimals', async () => {
    const { frong } = await deploy()
    expect(await frong.read.name()).to.equal('Mock FRONG')
    expect(await frong.read.symbol()).to.equal('tFRONG')
    expect(await frong.read.decimals()).to.equal(18)
  })

  it('drips DRIP_AMOUNT once per address per cooldown', async () => {
    const { player, frong } = await deploy()
    await frong.write.drip({ account: player.account } as never)
    expect(await frong.read.balanceOf([player.account.address])).to.equal(1_000n * 10n ** 18n)
  })

  it('rejects a second drip inside the cooldown', async () => {
    const { player, frong } = await deploy()
    await frong.write.drip({ account: player.account } as never)
    await expectRevert(frong.write.drip({ account: player.account } as never), 'cooldown')
  })
})
