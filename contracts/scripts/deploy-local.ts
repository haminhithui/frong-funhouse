import hre from 'hardhat'
import { parseEther } from 'viem'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Local deployment (localhost chain, chainId 31337): MockFRONG + FrongEntry +
 * FrongTrophy, with the first Hardhat account as admin/deployer and the second
 * as the minter. Treasury and gasReserve both default to the deployer address
 * (addresses only — no keys are derived or stored). Writes
 * contracts/deployments/localhost.json for the server.
 */
async function main() {
  const [deployer, minter] = await hre.viem.getWalletClients()
  const price = parseEther('1000')
  const treasury = deployer.account.address
  const gasReserve = deployer.account.address

  const frong = await hre.viem.deployContract('MockFRONG')
  const entry = await hre.viem.deployContract('FrongEntry', [
    frong.address,
    price,
    treasury,
    gasReserve,
    false,
  ])
  const trophy = await hre.viem.deployContract('FrongTrophy', [false])
  const trophyC = await hre.viem.getContractAt('FrongTrophy', trophy.address)
  await trophyC.write.setMinter([minter.account.address, true], { account: deployer.account })

  const publicClient = await hre.viem.getPublicClient()
  const chainId = await publicClient.getChainId()
  const deployment = {
    chainId,
    frong: frong.address,
    entry: entry.address,
    trophy: trophy.address,
    price: price.toString(),
    treasury,
    gasReserve,
    strictReceived: false,
    deployer: deployer.account.address,
    minter: minter.account.address,
    deployedAt: new Date().toISOString(),
  }

  const dir = join(__dirname, '..', 'deployments')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'localhost.json')
  writeFileSync(file, JSON.stringify(deployment, null, 2) + '\n')
  console.log('deployed on chain', chainId)
  console.log(JSON.stringify(deployment, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
