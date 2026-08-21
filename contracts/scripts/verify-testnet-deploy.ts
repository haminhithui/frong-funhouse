import 'dotenv/config'
import { createPublicClient, http, parseAbi } from 'viem'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RPC = process.env.FRONG_TESTNET_RPC_URL as string
// Browser URL comes from env (pinned in .env.example as verified live). The
// fallback is the same public URL; it is not a secret. BLOCKSCOUT_API_KEY is
// read ONLY from env by hardhat.config.ts during `hardhat verify` — it is
// never embedded in this repo.
const EXPLORER =
  process.env.BLOCKSCOUT_BROWSER_URL ?? 'https://explorer.testnet.chain.robinhood.com'

async function main() {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '..', 'deployments', 'testnet-46630.json'), 'utf8'),
  ) as {
    chainId: number
    frong: string
    entry: string
    trophy: string
    price: string
    treasury: string
    gasReserve: string
    strictReceived?: boolean
    deployer: string
    minter: string
  }

  const client = createPublicClient({ transport: http(RPC) })
  const chainId = await client.getChainId()
  console.log('CHAIN:', chainId, chainId === 46630 ? 'OK' : 'MISMATCH')
  console.log('MANIFEST chainId:', manifest.chainId, manifest.chainId === 46630 ? 'OK' : 'MISMATCH')
  console.log(
    'MANIFEST fee:',
    manifest.price,
    manifest.price === '1000000000000000000000' ? '(= 1000e18 OK)' : 'CHECK',
  )

  for (const [name, address] of [
    ['MockFRONG', manifest.frong],
    ['FrongEntry', manifest.entry],
    ['FrongTrophy', manifest.trophy],
  ] as const) {
    const code = await client.getCode({ address: address as `0x${string}` })
    console.log(
      'CODE ' + name + ':',
      address,
      code && code !== '0x' ? 'deployed (' + code.length + ' bytes)' : 'EMPTY!',
    )
  }

  const entryAbi = parseAbi([
    'function price() view returns (uint256)',
    'function frong() view returns (address)',
    'function owner() view returns (address)',
    'function treasury() view returns (address)',
    'function gasReserve() view returns (address)',
    'function strictReceived() view returns (bool)',
  ])
  const entry = await client.readContract({
    address: manifest.entry as `0x${string}`,
    abi: entryAbi,
    functionName: 'price',
  })
  console.log('ENTRY price:', entry.toString())
  const entryFrong = await client.readContract({
    address: manifest.entry as `0x${string}`,
    abi: parseAbi(['function frong() view returns (address)']),
    functionName: 'frong',
  })
  console.log(
    'ENTRY frong:',
    entryFrong,
    entryFrong.toLowerCase() === manifest.frong.toLowerCase() ? 'OK' : 'MISMATCH',
  )
  const entryTreasury = await client.readContract({
    address: manifest.entry as `0x${string}`,
    abi: parseAbi(['function treasury() view returns (address)']),
    functionName: 'treasury',
  })
  console.log(
    'ENTRY treasury:',
    entryTreasury,
    manifest.treasury && entryTreasury.toLowerCase() === manifest.treasury.toLowerCase()
      ? 'OK'
      : 'MISMATCH',
  )
  const entryGasReserve = await client.readContract({
    address: manifest.entry as `0x${string}`,
    abi: parseAbi(['function gasReserve() view returns (address)']),
    functionName: 'gasReserve',
  })
  console.log(
    'ENTRY gasReserve:',
    entryGasReserve,
    manifest.gasReserve && entryGasReserve.toLowerCase() === manifest.gasReserve.toLowerCase()
      ? 'OK'
      : 'MISMATCH',
  )
  const strictReceived = await client.readContract({
    address: manifest.entry as `0x${string}`,
    abi: parseAbi(['function strictReceived() view returns (bool)']),
    functionName: 'strictReceived',
  })
  console.log('ENTRY strictReceived:', strictReceived, strictReceived === false ? 'OK' : 'CHECK')
  const isMinter = await client.readContract({
    address: manifest.trophy as `0x${string}`,
    abi: parseAbi(['function minters(address) view returns (bool)']),
    functionName: 'minters',
    args: [manifest.minter as `0x${string}`],
  })
  console.log('TROPHY minters[minter]:', isMinter)
  const balance = await client.getBalance({ address: manifest.deployer as `0x${string}` })
  console.log('DEPLOYER balance now:', (Number(balance) / 1e18).toFixed(6), 'ETH')

  // Explorer: address pages + creation transactions from the Blockscout API.
  for (const [name, address] of [
    ['MockFRONG', manifest.frong],
    ['FrongEntry', manifest.entry],
    ['FrongTrophy', manifest.trophy],
  ] as const) {
    const page = await fetch(EXPLORER + '/address/' + address)
    console.log('EXPLORER ' + name + ' page:', page.status)
    const txlist = (await (
      await fetch(
        EXPLORER +
          '/api?module=account&action=txlist&address=' +
          address +
          '&page=1&offset=1&sort=asc',
      )
    ).json()) as { result?: { hash: string; blockNumber: string; from: string; gasUsed: string }[] }
    const creation = txlist.result && txlist.result.length > 0 ? txlist.result[0] : null
    console.log(
      'TX ' + name + ':',
      creation
        ? creation.hash + ' (block ' + creation.blockNumber + ', gas ' + creation.gasUsed + ')'
        : 'not found yet',
    )
  }

  // Exact source-verification commands (BLOCKSCOUT_API_KEY is read from env
  // by hardhat.config.ts, never embedded here).
  console.log('VERIFY commands:')
  console.log(
    '  npx hardhat verify --network frong-testnet',
    manifest.entry,
    manifest.frong,
    manifest.price,
    manifest.treasury,
    manifest.gasReserve,
    manifest.strictReceived === true ? 'true' : 'false',
  )
  console.log('  npx hardhat verify --network frong-testnet', manifest.trophy, 'false')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
