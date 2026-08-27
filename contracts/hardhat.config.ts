import type { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-viem'
import '@nomicfoundation/hardhat-verify'
import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

// All local Frong services share the single repo-root .env file.
loadDotenv({ path: resolve(__dirname, '..', '.env') })

/**
 * Localhost runs the real in-process/local EVM used by tests and the server
 * integration suite. The 46630/4663 networks take their RPC URLs and deployer
 * key from the environment: the official RPC URLs must be pinned from official
 * Robinhood Chain documentation before any real deployment — never hardcoded,
 * never guessed.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.26',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' },
  },
  networks: {
    localhost: { url: 'http://127.0.0.1:8545', chainId: 31337 },
    'frong-testnet': {
      url: process.env.FRONG_TESTNET_RPC_URL ?? '',
      chainId: 46630,
      // Funded deployer key comes ONLY from the environment — never hardcoded
      // in the repo, never committed.
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    'frong-mainnet': {
      url: process.env.FRONG_MAINNET_RPC_URL ?? '',
      chainId: 4663,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  // Blockscout source verification (testnet/mainnet): API + browser URLs come
  // from env, pinned from official docs — never guessed.
  etherscan:
    process.env.BLOCKSCOUT_API_URL && process.env.BLOCKSCOUT_BROWSER_URL
      ? {
          apiKey: {
            'frong-testnet': process.env.BLOCKSCOUT_API_KEY ?? 'unused',
            'frong-mainnet': process.env.BLOCKSCOUT_API_KEY ?? 'unused',
          },
          customChains: [
            {
              network: 'frong-testnet',
              chainId: 46630,
              urls: {
                apiURL: process.env.BLOCKSCOUT_API_URL,
                browserURL: process.env.BLOCKSCOUT_BROWSER_URL,
              },
            },
            {
              network: 'frong-mainnet',
              chainId: 4663,
              urls: {
                apiURL: process.env.BLOCKSCOUT_API_URL,
                browserURL: process.env.BLOCKSCOUT_BROWSER_URL,
              },
            },
          ],
        }
      : undefined,
}

export default config
