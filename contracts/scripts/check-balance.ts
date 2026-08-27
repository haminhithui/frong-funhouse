import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'
import { createPublicClient, http } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'

loadDotenv({ path: resolve(__dirname, '..', '.env') })

/** Prints the deployer's public address, balance, chain id, and gas price — never the key. */
async function main() {
  const rpc = process.env.FRONG_TESTNET_RPC_URL
  const key = process.env.DEPLOYER_PRIVATE_KEY
  if (!rpc || !key) throw new Error('FRONG_TESTNET_RPC_URL and DEPLOYER_PRIVATE_KEY are required')
  const client = createPublicClient({ transport: http(rpc) })
  const address = privateKeyToAddress(key as `0x${string}`)
  const balance = await client.getBalance({ address })
  const chainId = await client.getChainId()
  const gasPrice = await client.getGasPrice()
  const nonce = await client.getTransactionCount({ address })
  console.log('deployer address:', address)
  console.log('chainId:', chainId, '(expect 46630)')
  console.log('balance:', balance.toString(), 'wei =', (Number(balance) / 1e18).toFixed(6), 'ETH')
  console.log('nonce:', nonce)
  console.log('gasPrice:', gasPrice.toString(), 'wei')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
