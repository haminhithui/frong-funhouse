import { expect } from 'chai'
import hre from 'hardhat'
import { getAddress, parseEther, stringToHex, zeroAddress } from 'viem'
import { expectRevert } from './helpers'

const PRICE = parseEther('10')
const TIMELOCK = 24 * 60 * 60

describe('FrongEntry (FRONG entry payment)', () => {
  async function deploy(strictReceived = false) {
    const [deployer, player, treasury, gasReserve, other] = await hre.viem.getWalletClients()
    const frong = await hre.viem.deployContract('MockFRONG')
    const entry = await hre.viem.deployContract('FrongEntry', [
      frong.address,
      PRICE,
      treasury.account.address,
      gasReserve.account.address,
      strictReceived,
    ])
    const frongC = await hre.viem.getContractAt('MockFRONG', frong.address)
    const entryC = await hre.viem.getContractAt('FrongEntry', entry.address)
    return { deployer, player, treasury, gasReserve, other, frong: frongC, entry: entryC }
  }

  it('pulls exactly the price and emits Paid(player, paymentId, amount)', async () => {
    const { player, frong, entry } = await deploy()
    await frong.write.drip({ account: player.account } as never)
    await frong.write.approve([entry.address, PRICE], { account: player.account })
    const paymentId = stringToHex('payment-1', { size: 32 })

    await entry.write.play([paymentId], { account: player.account })

    expect(await frong.read.balanceOf([entry.address])).to.equal(PRICE)
    const events = await entry.getEvents.Paid()
    expect(events).to.have.length(1)
    const args = events[0].args as { player?: string; paymentId?: string; amount?: bigint }
    expect(args.player?.toLowerCase()).to.equal(player.account.address.toLowerCase())
    expect(args.paymentId).to.equal(paymentId)
    expect(args.amount).to.equal(PRICE)
  })

  it('reverts when the allowance is below the price', async () => {
    const { player, frong, entry } = await deploy()
    await frong.write.drip({ account: player.account } as never)
    await frong.write.approve([entry.address, PRICE - 1n], { account: player.account })
    await expectRevert(
      entry.write.play([stringToHex('x', { size: 32 })], { account: player.account }),
      'InsufficientAllowance',
    )
  })

  it('reverts while paused and works again after unpause', async () => {
    const { deployer, player, frong, entry } = await deploy()
    await frong.write.drip({ account: player.account } as never)
    await frong.write.approve([entry.address, PRICE], { account: player.account })
    await entry.write.setPaused([true], { account: deployer.account })
    await expectRevert(
      entry.write.play([stringToHex('x', { size: 32 })], { account: player.account }),
      'paused',
    )
    await entry.write.setPaused([false], { account: deployer.account })
    await entry.write.play([stringToHex('x', { size: 32 })], { account: player.account })
  })

  it('keeps setPrice owner-only', async () => {
    const { deployer, player, entry } = await deploy()
    await expectRevert(entry.write.setPrice([PRICE + 1n], { account: player.account }), 'not owner')
    await entry.write.setPrice([PRICE + 1n], { account: deployer.account })
    expect(await entry.read.price()).to.equal(PRICE)
    await expectRevert(
      entry.write.acceptPrice({ account: deployer.account } as never),
      'price timelock',
    )
    await hre.network.provider.send('evm_increaseTime', [TIMELOCK + 1])
    await hre.network.provider.send('evm_mine')
    await entry.write.acceptPrice({ account: deployer.account } as never)
    expect(await entry.read.price()).to.equal(PRICE + 1n)
  })

  it('D2: keeps price changes inside bounds and emits a scheduled audit trail', async () => {
    const { deployer, entry } = await deploy()
    const min = (await entry.read.MIN_PRICE()) as bigint
    const max = (await entry.read.MAX_PRICE()) as bigint
    await expectRevert(
      entry.write.setPrice([max + 1n], { account: deployer.account }),
      'price bounds',
    )
    await expectRevert(
      entry.write.setPrice([min - 1n], { account: deployer.account }),
      'price bounds',
    )
    await entry.write.setPrice([PRICE + 7n], { account: deployer.account })
    const proposed = await entry.getEvents.PriceProposed(undefined, { fromBlock: 0n })
    expect(proposed).to.have.length(1)
    await hre.network.provider.send('evm_increaseTime', [TIMELOCK + 1])
    await hre.network.provider.send('evm_mine')
    await entry.write.acceptPrice({ account: deployer.account } as never)
    const events = await entry.getEvents.PriceUpdated(undefined, { fromBlock: 0n })
    expect(events).to.have.length(1)
    const args = events[0].args as { oldPrice?: bigint; newPrice?: bigint }
    expect(args.oldPrice).to.equal(PRICE)
    expect(args.newPrice).to.equal(PRICE + 7n)
  })

  it('D2: rotates the owner only via 2-step propose/accept with a 24h timelock', async () => {
    const { deployer, player, other, entry } = await deploy()
    await expectRevert(
      entry.write.proposeOwner([other.account.address], { account: player.account }),
      'not owner',
    )
    await entry.write.proposeOwner([other.account.address], { account: deployer.account })
    await expectRevert(
      entry.write.acceptOwner({ account: player.account } as never),
      'not pending owner',
    )
    await expectRevert(
      entry.write.acceptOwner({ account: other.account } as never),
      'owner timelock',
    )
    await hre.network.provider.send('evm_increaseTime', [24 * 60 * 60 + 1])
    await hre.network.provider.send('evm_mine')
    await entry.write.acceptOwner({ account: other.account } as never)
    expect(getAddress((await entry.read.owner()) as string)).to.equal(
      getAddress(other.account.address),
    )
    // The old owner is locked out; the new owner holds the price lever.
    await expectRevert(
      entry.write.setPrice([PRICE + 1n], { account: deployer.account }),
      'not owner',
    )
    await entry.write.setPrice([PRICE + 2n], { account: other.account } as never)
  })

  it('D2: rejects a deploy-time price outside the bounds', async () => {
    const [deployer] = await hre.viem.getWalletClients()
    const frong = await hre.viem.deployContract('MockFRONG')
    await expectRevert(
      hre.viem.deployContract('FrongEntry', [
        frong.address,
        1_000_001n * 10n ** 18n,
        deployer.account.address,
        deployer.account.address,
        false,
      ]),
      'price bounds',
    )
  })

  it('emits the price charged at payment time when price changes between plays', async () => {
    const { deployer, player, frong, entry } = await deploy()
    await frong.write.drip({ account: player.account } as never)
    await frong.write.approve([entry.address, parseEther('1000')], { account: player.account })
    await entry.write.play([stringToHex('p1', { size: 32 })], { account: player.account })
    const newPrice = PRICE + parseEther('5')
    await entry.write.setPrice([newPrice], { account: deployer.account })
    await hre.network.provider.send('evm_increaseTime', [TIMELOCK + 1])
    await hre.network.provider.send('evm_mine')
    await entry.write.acceptPrice({ account: deployer.account } as never)
    await entry.write.play([stringToHex('p2', { size: 32 })], { account: player.account })

    // viem getEvents.Paid(args?, options?): block range is the OPTIONS arg.
    const events = await entry.getEvents.Paid(undefined, { fromBlock: 0n })
    expect(events).to.have.length(2)
    const amounts = events.map((e) => (e.args as { amount?: bigint }).amount)
    expect(amounts[0]).to.equal(PRICE)
    expect(amounts[1]).to.equal(newPrice)
  })

  it('sweep() splits 70% to treasury and the remainder to gasReserve', async () => {
    const { deployer, treasury, gasReserve, frong, entry } = await deploy()
    const total = 10_000_000_000_000_000_123n // 10e18 + 123 wei, exercises rounding dust
    await frong.write.drip({ account: deployer.account } as never)
    await frong.write.transfer([entry.address, total], { account: deployer.account })
    await entry.write.sweep({ account: deployer.account } as never)

    const toTreasury = (total * 70n) / 100n
    const toGas = total - toTreasury
    expect(await frong.read.balanceOf([treasury.account.address])).to.equal(toTreasury)
    expect(await frong.read.balanceOf([gasReserve.account.address])).to.equal(toGas)
    expect(await frong.read.balanceOf([entry.address])).to.equal(0n)

    const events = await entry.getEvents.Swept()
    expect(events).to.have.length(1)
    const args = events[0].args as {
      treasury?: string
      gasReserve?: string
      toTreasury?: bigint
      toGas?: bigint
    }
    expect(args.treasury?.toLowerCase()).to.equal(treasury.account.address.toLowerCase())
    expect(args.gasReserve?.toLowerCase()).to.equal(gasReserve.account.address.toLowerCase())
    expect(args.toTreasury).to.equal(toTreasury)
    expect(args.toGas).to.equal(toGas)
  })

  it('rotates treasury via 2-step propose/accept with a 24h timelock', async () => {
    const { deployer, player, other, entry } = await deploy()
    await expectRevert(
      entry.write.proposeTreasury([other.account.address], { account: player.account }),
      'not owner',
    )
    await entry.write.proposeTreasury([other.account.address], { account: deployer.account })
    await expectRevert(
      entry.write.acceptTreasury({ account: deployer.account } as never),
      'treasury timelock',
    )
    await hre.network.provider.send('evm_increaseTime', [TIMELOCK + 1])
    await hre.network.provider.send('evm_mine')
    await entry.write.acceptTreasury({ account: deployer.account } as never)
    expect(await entry.read.treasury()).to.equal(getAddress(other.account.address))
  })

  it('rotates gasReserve via 2-step propose/accept with a 24h timelock', async () => {
    const { deployer, player, other, entry } = await deploy()
    await expectRevert(
      entry.write.proposeGasReserve([other.account.address], { account: player.account }),
      'not owner',
    )
    await entry.write.proposeGasReserve([other.account.address], { account: deployer.account })
    await expectRevert(
      entry.write.acceptGasReserve({ account: deployer.account } as never),
      'gas reserve timelock',
    )
    await hre.network.provider.send('evm_increaseTime', [TIMELOCK + 1])
    await hre.network.provider.send('evm_mine')
    await entry.write.acceptGasReserve({ account: deployer.account } as never)
    expect(await entry.read.gasReserve()).to.equal(getAddress(other.account.address))
  })

  it('rejects zero frong/price/treasury/gasReserve at construction', async () => {
    const [, player] = await hre.viem.getWalletClients()
    const frong = await hre.viem.deployContract('MockFRONG')
    const good = {
      frong: frong.address,
      price: PRICE,
      treasury: player.account.address,
      gas: player.account.address,
    }
    await expectRevert(
      hre.viem.deployContract('FrongEntry', [zeroAddress, PRICE, good.treasury, good.gas, false]),
      'zero frong',
    )
    await expectRevert(
      hre.viem.deployContract('FrongEntry', [frong.address, 0n, good.treasury, good.gas, false]),
      'price bounds',
    )
    await expectRevert(
      hre.viem.deployContract('FrongEntry', [frong.address, PRICE, zeroAddress, good.gas, false]),
      'zero treasury',
    )
    await expectRevert(
      hre.viem.deployContract('FrongEntry', [
        frong.address,
        PRICE,
        good.treasury,
        zeroAddress,
        false,
      ]),
      'zero gas reserve',
    )
  })

  it('strictReceived=true rejects fee-on-transfer tokens', async () => {
    const [deployer, player, treasury, gasReserve] = await hre.viem.getWalletClients()
    const tax = await hre.viem.deployContract('MockTaxToken')
    const entry = await hre.viem.deployContract('FrongEntry', [
      tax.address,
      PRICE,
      treasury.account.address,
      gasReserve.account.address,
      true,
    ])
    const taxC = await hre.viem.getContractAt('MockTaxToken', tax.address)
    const entryC = await hre.viem.getContractAt('FrongEntry', entry.address)
    await taxC.write.mintTo([player.account.address, PRICE], { account: deployer.account })
    await taxC.write.approve([entry.address, PRICE], { account: player.account })
    await expectRevert(
      entryC.write.play([stringToHex('tax', { size: 32 })], { account: player.account }),
      'fee-on-transfer',
    )
  })

  it('strictReceived=false accepts fee-on-transfer tokens (legacy behaviour)', async () => {
    const [deployer, player, treasury, gasReserve] = await hre.viem.getWalletClients()
    const tax = await hre.viem.deployContract('MockTaxToken')
    const entry = await hre.viem.deployContract('FrongEntry', [
      tax.address,
      PRICE,
      treasury.account.address,
      gasReserve.account.address,
      false,
    ])
    const taxC = await hre.viem.getContractAt('MockTaxToken', tax.address)
    const entryC = await hre.viem.getContractAt('FrongEntry', entry.address)
    await taxC.write.mintTo([player.account.address, PRICE], { account: deployer.account })
    await taxC.write.approve([entry.address, PRICE], { account: player.account })
    await entryC.write.play([stringToHex('tax', { size: 32 })], { account: player.account })

    const events = await entryC.getEvents.Paid()
    expect(events).to.have.length(1)
    expect((events[0].args as { amount?: bigint }).amount).to.equal(PRICE)
    // The contract actually received less than price due to the 1% tax.
    const fee = (PRICE * 100n) / 10_000n
    expect(await taxC.read.balanceOf([entry.address])).to.equal(PRICE - fee)
  })

  it('strictReceived=true with a standard token charges exactly price', async () => {
    const { player, frong, entry } = await deploy(true)
    await frong.write.drip({ account: player.account } as never)
    await frong.write.approve([entry.address, PRICE], { account: player.account })
    await entry.write.play([stringToHex('s', { size: 32 })], { account: player.account })
    const events = await entry.getEvents.Paid()
    expect((events[0].args as { amount?: bigint }).amount).to.equal(PRICE)
    expect(await frong.read.balanceOf([entry.address])).to.equal(PRICE)
    expect(await entry.read.strictReceived()).to.equal(true)
  })

  it('blocks re-entrancy from a malicious token transferFrom', async () => {
    const { deployer, player, treasury, gasReserve } = await deploy()
    const token = await hre.viem.deployContract('ReenterToken')
    const entry = await hre.viem.deployContract('FrongEntry', [
      token.address,
      PRICE,
      treasury.account.address,
      gasReserve.account.address,
      false,
    ])
    const tokenC = await hre.viem.getContractAt('ReenterToken', token.address)
    const entryC = await hre.viem.getContractAt('FrongEntry', entry.address)
    await tokenC.write.setEntry([entry.address])
    await tokenC.write.mintTo([player.account.address, PRICE], { account: deployer.account })
    await tokenC.write.approve([entry.address, PRICE], { account: player.account })
    await expectRevert(
      entryC.write.play([stringToHex('re', { size: 32 })], { account: player.account }),
      'ReentrancyGuardReentrantCall',
    )
  })
})
