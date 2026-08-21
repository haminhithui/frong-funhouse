import { defineChain } from 'viem'
import type { ServerConfig } from './config'

/**
 * Chain object for the configured chain id. 46630 = Robinhood Chain testnet,
 * 4663 = Robinhood Chain mainnet; anything else (e.g. 31337) is a local EVM.
 * Native currency details for 46630/4663 must be confirmed against official
 * Robinhood Chain documentation before mainnet use.
 */
export function chainFor(config: ServerConfig) {
  const name =
    config.chainId === 46630
      ? 'Robinhood Chain Testnet'
      : config.chainId === 4663
        ? 'Robinhood Chain'
        : 'Local EVM'
  return defineChain({
    id: config.chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  })
}
