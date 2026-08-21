import 'dotenv/config'
import hre from 'hardhat'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Finalizes an existing testnet deployment WITHOUT redeploying: grants the
 * minter role on the trophy contract and writes the manifest
 * (contracts/deployments/testnet-46630.json). Used to resume a deploy whose
 * finalization step failed, and for minter rotation later.
 *
 * Env: FRONG_TESTNET_RPC_URL, DEPLOYER_PRIVATE_KEY, FRONG_ADDRESS,
 * ENTRY_ADDRESS, TROPHY_ADDRESS, TREASURY_ADDRESS, GAS_RESERVE_ADDRESS,
 * ENTRY_FEE_WEI, MINTER_ADDRESS (optional — defaults to the deployer).
 */
async function main() {
  const frong = process.env.FRONG_ADDRESS
  const entry = process.env.ENTRY_ADDRESS
  const trophy = process.env.TROPHY_ADDRESS
  const treasury = process.env.TREASURY_ADDRESS
  const gasReserve = process.env.GAS_RESERVE_ADDRESS
  const feeWei = process.env.ENTRY_FEE_WEI ?? '1000000000000000000000'
  if (!frong || !entry || !trophy || !treasury || !gasReserve) {
    throw new Error(
      'FRONG_ADDRESS, ENTRY_ADDRESS, TROPHY_ADDRESS, TREASURY_ADDRESS, and GAS_RESERVE_ADDRESS are required',
    )
  }
  if (!/^[0-9]+$/.test(feeWei)) throw new Error('ENTRY_FEE_WEI must be an integer in wei')

  const publicClient = await hre.viem.getPublicClient()
  const chainId = await publicClient.getChainId()
  if (chainId !== 46630) throw new Error('expected chain 46630, got ' + chainId)

  const [deployer] = await hre.viem.getWalletClients()
  const minterAddress = process.env.MINTER_ADDRESS ?? deployer.account.address
  const trophyC = await hre.viem.getContractAt('FrongTrophy', trophy as `0x${string}`)
  await trophyC.write.setMinter([minterAddress, true], { account: deployer.account } as never)
  console.log('[finalize] minter role granted to', minterAddress)

  const manifest = {
    chainId: 46630,
    frong,
    entry,
    trophy,
    price: feeWei,
    treasury,
    gasReserve,
    strictReceived: false,
    deployer: deployer.account.address,
    minter: minterAddress,
    officialFrong: false,
    deployedAt: new Date().toISOString(),
  }
  const dir = join(__dirname, '..', 'deployments')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'testnet-46630.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('[finalize] wrote contracts/deployments/testnet-46630.json')
  console.log('[verify] FrongEntry:')
  console.log(
    '  npx hardhat verify --network frong-testnet',
    entry,
    frong,
    feeWei,
    treasury,
    gasReserve,
    'false',
  )
  console.log('[verify] FrongTrophy:')
  console.log('  npx hardhat verify --network frong-testnet', trophy, 'false')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
