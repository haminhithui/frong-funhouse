import hre from 'hardhat'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dev utility: drips tFRONG to the first Hardhat account (the one a browser
 * with an injected node-backed wallet connects as) so the full paid flow can
 * be exercised locally without touching the faucet from the UI.
 */
async function main() {
  const deployment = JSON.parse(
    readFileSync(join(__dirname, '..', 'deployments', 'localhost.json'), 'utf8'),
  ) as { frong: string }
  const frong = await hre.viem.getContractAt('MockFRONG', deployment.frong as `0x${string}`)
  const [player] = await hre.viem.getWalletClients()
  await frong.write.drip()
  const balance = (await frong.read.balanceOf([player.account.address])) as bigint
  console.log('funded', player.account.address, 'with', balance.toString(), 'tFRONG')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
