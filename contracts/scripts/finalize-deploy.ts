import { config as loadDotenv } from 'dotenv'
import hre from 'hardhat'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { requireAddress, requirePositiveWei } from './validation'

loadDotenv({ path: join(__dirname, '..', '.env') })

/**
 * Finalizes an existing testnet deployment WITHOUT redeploying: grants the
 * minter role on the trophy contract, proposes governance ownership, and writes the manifest
 * (contracts/deployments/testnet-46630.json). Used to resume a deploy whose
 * finalization step failed, and for minter rotation later.
 *
 * Env: FRONG_TESTNET_RPC_URL, DEPLOYER_PRIVATE_KEY, FRONG_ADDRESS,
 * ENTRY_ADDRESS, TROPHY_ADDRESS, TREASURY_ADDRESS, GAS_RESERVE_ADDRESS,
 * ENTRY_FEE_WEI, MINTER_ADDRESS, GOVERNANCE_ADDRESS (required and must differ
 * from the deployer).
 */
async function main() {
  const frong = process.env.FRONG_ADDRESS
  const entry = process.env.ENTRY_ADDRESS
  const trophy = process.env.TROPHY_ADDRESS
  const treasury = process.env.TREASURY_ADDRESS
  const gasReserve = process.env.GAS_RESERVE_ADDRESS
  const feeWei = process.env.ENTRY_FEE_WEI ?? '1000000000000000000000'
  const minterAddress = process.env.MINTER_ADDRESS
  const governanceAddress = process.env.GOVERNANCE_ADDRESS
  if (!frong || !entry || !trophy || !treasury || !gasReserve || !governanceAddress) {
    throw new Error(
      'FRONG_ADDRESS, ENTRY_ADDRESS, TROPHY_ADDRESS, TREASURY_ADDRESS, GAS_RESERVE_ADDRESS, and GOVERNANCE_ADDRESS are required',
    )
  }
  if (!minterAddress)
    throw new Error('MINTER_ADDRESS is required and must be a separate team minter')
  requireAddress(frong, 'FRONG_ADDRESS')
  requireAddress(entry, 'ENTRY_ADDRESS')
  requireAddress(trophy, 'TROPHY_ADDRESS')
  requireAddress(treasury, 'TREASURY_ADDRESS')
  requireAddress(gasReserve, 'GAS_RESERVE_ADDRESS')
  requireAddress(minterAddress, 'MINTER_ADDRESS')
  requireAddress(governanceAddress, 'GOVERNANCE_ADDRESS')
  const expectedPrice = requirePositiveWei(feeWei, 'ENTRY_FEE_WEI')
  if (expectedPrice < 1_000_000_000_000_000_000n || expectedPrice > 1_000_000n * 10n ** 18n) {
    throw new Error('ENTRY_FEE_WEI must be between 1 and 1,000,000 FRONG')
  }

  const publicClient = await hre.viem.getPublicClient()
  const chainId = await publicClient.getChainId()
  if (chainId !== 46630) throw new Error('expected chain 46630, got ' + chainId)

  const [deployer] = await hre.viem.getWalletClients()
  if (minterAddress.toLowerCase() === deployer.account.address.toLowerCase()) {
    throw new Error('MINTER_ADDRESS must not equal the deployer account')
  }
  if (governanceAddress.toLowerCase() === deployer.account.address.toLowerCase()) {
    throw new Error('GOVERNANCE_ADDRESS must not equal the deployer account')
  }
  if (minterAddress.toLowerCase() === governanceAddress.toLowerCase()) {
    throw new Error('MINTER_ADDRESS and GOVERNANCE_ADDRESS must be separate authorities')
  }
  const governanceCode = await publicClient.getBytecode({
    address: governanceAddress as `0x${string}`,
  })
  if (!governanceCode || governanceCode === '0x') {
    throw new Error('GOVERNANCE_ADDRESS must point to a deployed Safe/multisig contract')
  }
  const entryC = await hre.viem.getContractAt('FrongEntry', entry as `0x${string}`)
  if (!(await entryC.read.strictReceived())) {
    throw new Error('existing FrongEntry was not deployed with strictReceived=true')
  }
  const deployedFrong = String(await entryC.read.frong())
  if (deployedFrong.toLowerCase() !== frong.toLowerCase()) {
    throw new Error('FRONG_ADDRESS does not match the deployed FrongEntry token')
  }
  const deployedPrice = BigInt(String(await entryC.read.price()))
  if (deployedPrice !== expectedPrice) {
    throw new Error('ENTRY_FEE_WEI does not match the deployed FrongEntry price')
  }
  const deployedTreasury = String(await entryC.read.treasury())
  if (deployedTreasury.toLowerCase() !== treasury.toLowerCase()) {
    throw new Error('TREASURY_ADDRESS does not match the deployed FrongEntry treasury')
  }
  const deployedGasReserve = String(await entryC.read.gasReserve())
  if (deployedGasReserve.toLowerCase() !== gasReserve.toLowerCase()) {
    throw new Error('GAS_RESERVE_ADDRESS does not match the deployed FrongEntry gas reserve')
  }
  const trophyC = await hre.viem.getContractAt('FrongTrophy', trophy as `0x${string}`)
  if (await trophyC.read.soulbound()) {
    throw new Error('existing FrongTrophy is soulbound; FRONG Catch requires transferable trophies')
  }
  await trophyC.write.setMinter([minterAddress, true], { account: deployer.account } as never)
  console.log('[finalize] minter role granted to', minterAddress)
  await entryC.write.proposeOwner([governanceAddress], { account: deployer.account } as never)
  await trophyC.write.proposeAdmin([governanceAddress], { account: deployer.account } as never)
  console.log('[finalize] governance rotation proposed; accept after 24h from', governanceAddress)

  const manifest = {
    chainId: 46630,
    frong,
    entry,
    trophy,
    price: feeWei,
    treasury,
    gasReserve,
    strictReceived: true,
    deployer: deployer.account.address,
    minter: minterAddress,
    governance: governanceAddress,
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
    'true',
  )
  console.log('[verify] FrongTrophy:')
  console.log('  npx hardhat verify --network frong-testnet', trophy, 'false')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
