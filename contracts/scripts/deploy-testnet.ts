import hre from 'hardhat'
import type { Hex } from 'viem'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireAddress, requirePositiveWei, requirePublicHttpsUrl } from './validation'

const RPC = process.env.FRONG_TESTNET_RPC_URL ?? ''
const OFFICIAL_FRONG = process.env.OFFICIAL_FRONG_ADDRESS ?? ''
/** Reuse an already-deployed MockFRONG (resume a partially completed deploy). */
const MOCK_FRONG = process.env.MOCK_FRONG_ADDRESS ?? ''
/** Entry fee in WEI (raw token units — never parsed as ether). Default 1000 FRONG. */
const FEE_WEI = process.env.ENTRY_FEE_WEI ?? '1000000000000000000000'
const TREASURY = process.env.TREASURY_ADDRESS ?? ''
const GAS_RESERVE = process.env.GAS_RESERVE_ADDRESS ?? ''
const MINTER = process.env.MINTER_ADDRESS ?? ''
/** Safe/multisig governance address; deployer remains temporary admin for setup. */
const GOVERNANCE = process.env.GOVERNANCE_ADDRESS ?? ''
/** Rehearsal mode: run the exact deploy path against a local EVM (31337). */
const DRY_RUN = process.env.DEPLOY_DRY_RUN === '1'

/**
 * Testnet 46630 deployment. Fails loudly unless the official RPC URL (pinned
 * from official Robinhood Chain docs — never guessed), a funded deployer key,
 * TREASURY_ADDRESS, GAS_RESERVE_ADDRESS, and a MINTER_ADDRESS that differs
 * from the deployer are provided. Deploys MockFRONG unless an official testnet
 * FRONG is given. Writes deployments/testnet-46630.json for the game server.
 */
async function main() {
  if (!DRY_RUN && hre.network.name !== 'frong-testnet') {
    throw new Error('run with --network frong-testnet (or DEPLOY_DRY_RUN=1 for a local rehearsal)')
  }
  if (OFFICIAL_FRONG && MOCK_FRONG) {
    throw new Error('set only one of OFFICIAL_FRONG_ADDRESS or MOCK_FRONG_ADDRESS')
  }
  const missing: string[] = []
  if (!DRY_RUN && !RPC)
    missing.push(
      'FRONG_TESTNET_RPC_URL (official 46630 RPC, pinned from official Robinhood Chain docs)',
    )
  if (!DRY_RUN && !process.env.DEPLOYER_PRIVATE_KEY) {
    missing.push(
      'DEPLOYER_PRIVATE_KEY (funded 46630 deployer key — environment only, never hardcoded in the repo)',
    )
  }
  if (!TREASURY) missing.push('TREASURY_ADDRESS (FRONG sweep treasury destination)')
  if (!GAS_RESERVE) missing.push('GAS_RESERVE_ADDRESS (gas-sponsorship float)')
  if (!MINTER) missing.push('MINTER_ADDRESS (team minter — must differ from the deployer account)')
  if (!GOVERNANCE) missing.push('GOVERNANCE_ADDRESS (Safe/multisig owner and admin destination)')
  if (missing.length > 0) {
    throw new Error(
      'cannot deploy to testnet — missing environment values:\n  - ' + missing.join('\n  - '),
    )
  }
  if (!DRY_RUN) requirePublicHttpsUrl(RPC, 'FRONG_TESTNET_RPC_URL')
  if (OFFICIAL_FRONG) requireAddress(OFFICIAL_FRONG, 'OFFICIAL_FRONG_ADDRESS')
  if (MOCK_FRONG) requireAddress(MOCK_FRONG, 'MOCK_FRONG_ADDRESS')
  requireAddress(TREASURY, 'TREASURY_ADDRESS')
  requireAddress(GAS_RESERVE, 'GAS_RESERVE_ADDRESS')
  requireAddress(MINTER, 'MINTER_ADDRESS')
  requireAddress(GOVERNANCE, 'GOVERNANCE_ADDRESS')

  const publicClient = await hre.viem.getPublicClient()
  const chainId = await publicClient.getChainId()
  if (DRY_RUN) {
    if (chainId !== 31337) {
      throw new Error('dry run expects the local EVM (31337), got ' + chainId)
    }
    console.log('[dry-run] REHEARSAL on local EVM — nothing is deployed to 46630')
  } else if (chainId !== 46630) {
    throw new Error('expected chain 46630, got ' + chainId + ' — check FRONG_TESTNET_RPC_URL')
  }

  const [deployer] = await hre.viem.getWalletClients()

  /**
   * Receipt-based deployment: address and hash come from the MINED receipt
   * (waitForTransactionReceipt retries internally), so a public RPC that
   * lags getTransaction can never fake or lose a deployment.
   */
  async function deploy(
    name: string,
    args: unknown[] = [],
  ): Promise<{ address: string; hash: string }> {
    const artifact = await hre.artifacts.readArtifact(name)
    const hash = await deployer.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode as Hex,
      args: args as never,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(name + ' deploy reverted: ' + hash)
    if (!receipt.contractAddress)
      throw new Error(name + ' receipt missing contract address: ' + hash)
    return { address: receipt.contractAddress, hash }
  }

  const txs: Record<string, string> = {}
  let frongAddress = OFFICIAL_FRONG || MOCK_FRONG
  if (!frongAddress) {
    const sent = await deploy('MockFRONG')
    frongAddress = sent.address
    txs.frong = sent.hash
    console.log('[deploy] MockFRONG (tFRONG) at', frongAddress, 'tx', txs.frong)
  } else if (MOCK_FRONG) {
    console.log('[deploy] reusing deployed MockFRONG at', frongAddress)
  } else {
    console.log('[deploy] using official testnet FRONG at', frongAddress)
  }

  const price = requirePositiveWei(FEE_WEI, 'ENTRY_FEE_WEI')
  if (price < 1_000_000_000_000_000_000n || price > 1_000_000n * 10n ** 18n) {
    throw new Error('ENTRY_FEE_WEI must be between 1 and 1,000,000 FRONG')
  }
  // Minter must be an explicit, distinct address — never the deployer.
  if (MINTER.toLowerCase() === deployer.account.address.toLowerCase()) {
    throw new Error('MINTER_ADDRESS must not equal the deployer account')
  }
  if (GOVERNANCE.toLowerCase() === deployer.account.address.toLowerCase()) {
    throw new Error('GOVERNANCE_ADDRESS must not equal the deployer account')
  }
  if (MINTER.toLowerCase() === GOVERNANCE.toLowerCase()) {
    throw new Error('MINTER_ADDRESS and GOVERNANCE_ADDRESS must be separate authorities')
  }
  if (!DRY_RUN) {
    const governanceCode = await publicClient.getBytecode({ address: GOVERNANCE as `0x${string}` })
    if (!governanceCode || governanceCode === '0x') {
      throw new Error('GOVERNANCE_ADDRESS must point to a deployed Safe/multisig contract')
    }
  }
  const entrySent = await deploy('FrongEntry', [frongAddress, price, TREASURY, GAS_RESERVE, true])
  txs.entry = entrySent.hash
  console.log('[deploy] FrongEntry at', entrySent.address, '(fee', FEE_WEI, 'wei) tx', txs.entry)
  const trophySent = await deploy('FrongTrophy', [false])
  txs.trophy = trophySent.hash
  console.log('[deploy] FrongTrophy at', trophySent.address, 'tx', txs.trophy)
  const entry = await hre.viem.getContractAt('FrongEntry', entrySent.address as `0x${string}`)
  const trophy = await hre.viem.getContractAt('FrongTrophy', trophySent.address as `0x${string}`)
  const trophyC = await hre.viem.getContractAt('FrongTrophy', trophy.address)
  await trophyC.write.setMinter([MINTER, true], {
    account: deployer.account,
  } as never)
  console.log('[deploy] minter role granted to', MINTER)
  await entry.write.proposeOwner([GOVERNANCE], { account: deployer.account } as never)
  await trophyC.write.proposeAdmin([GOVERNANCE], { account: deployer.account })
  console.log('[deploy] governance rotation proposed; accept after 24h from', GOVERNANCE)

  const deployment = {
    chainId: DRY_RUN ? 31337 : 46630,
    frong: frongAddress,
    entry: entry.address,
    trophy: trophy.address,
    price: price.toString(),
    treasury: TREASURY,
    gasReserve: GAS_RESERVE,
    strictReceived: true,
    deployer: deployer.account.address,
    minter: MINTER,
    governance: GOVERNANCE,
    officialFrong: OFFICIAL_FRONG !== '',
    mockFrongReused: MOCK_FRONG !== '',
    txs,
    deployedAt: new Date().toISOString(),
  }
  const dir = join(__dirname, '..', 'deployments')
  mkdirSync(dir, { recursive: true })
  const recordFile = DRY_RUN ? 'testnet-46630.dry-run.json' : 'testnet-46630.json'
  writeFileSync(join(dir, recordFile), JSON.stringify(deployment, null, 2) + '\n')
  console.log('[deploy] wrote contracts/deployments/' + recordFile)
  if (!DRY_RUN) {
    console.log('[verify] FrongEntry:')
    console.log(
      '  npx hardhat verify --network frong-testnet',
      entry.address,
      frongAddress,
      FEE_WEI,
      TREASURY,
      GAS_RESERVE,
      'true',
    )
    console.log('[verify] FrongTrophy:')
    console.log('  npx hardhat verify --network frong-testnet', trophy.address, 'false')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
