import { createWalletClient, custom, defineChain } from 'viem'
import type { Account, Chain, EIP1193Provider, Hex, Transport, WalletClient } from 'viem'
import {
  APP_DESCRIPTION,
  APP_ICONS,
  APP_NAME,
  APP_URL,
  SUPPORTED_CHAIN_IDS,
  WC_PROJECT_ID,
  explorerUrlFor,
  isRpcConfigured,
  rpcUrlFor,
} from './config'

export interface WalletHandle {
  address: string
  chainId: number
  client: WalletClient<Transport, Chain, Account | undefined>
  provider: EIP1193Provider
}

export function chainFor(chainId: number) {
  const name =
    chainId === 46630
      ? 'Robinhood Chain Testnet'
      : chainId === 4663
        ? 'Robinhood Chain'
        : 'Local EVM'
  const explorer = explorerUrlFor(chainId)
  const rpcUrl = rpcUrlFor(chainId)
  return defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // A custom EIP-1193 transport can still use this chain descriptor when
    // the mainnet RPC is intentionally absent. Do not invent localhost as a
    // replacement for chain 4663.
    rpcUrls: { default: { http: rpcUrl ? [rpcUrl] : [] } },
    ...(explorer ? { blockExplorers: { default: { name: 'Blockscout', url: explorer } } } : {}),
  })
}

function injectedProvider(): EIP1193Provider | null {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum
  return provider ?? null
}

/** EIP-1193 injected wallet (MetaMask and compatible). */
export async function connectInjected(): Promise<WalletHandle | null> {
  const provider = injectedProvider()
  if (!provider) return null
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accounts || accounts.length === 0) return null
  const address = accounts[0]
  const chainId = Number((await provider.request({ method: 'eth_chainId' })) as string)
  return {
    address,
    chainId,
    client: createWalletClient({ chain: chainFor(chainId), transport: custom(provider) }),
    provider,
  }
}

export interface WalletConnectOptions {
  projectId: string
  chains: [number, ...number[]]
  optionalChains: [number, ...number[]]
  /** Required for chains without public RPC defaults in WalletConnect's registry. */
  rpcMap: Record<number, string>
  metadata: { name: string; description: string; url: string; icons: string[] }
  showQrModal: boolean
  methods: string[]
}

/**
 * Full WalletConnect v2 options: the real project id (VITE_WC_PROJECT_ID),
 * per-chain RPC map (46630/4663 from official docs via env), and app metadata
 * shown in the pairing modal. Returns null when no project id is configured —
 * the button is then disabled, never fake-connected.
 */
export function walletConnectOptions(): WalletConnectOptions | null {
  if (!WC_PROJECT_ID) return null
  const chainIds = SUPPORTED_CHAIN_IDS.filter((chainId) => isRpcConfigured(chainId))
  if (chainIds.length === 0) return null
  const rpcMap = Object.fromEntries(
    chainIds.map((chainId) => [chainId, rpcUrlFor(chainId)]),
  ) as Record<number, string>
  return {
    projectId: WC_PROJECT_ID,
    chains: chainIds as [number, ...number[]],
    optionalChains: chainIds as [number, ...number[]],
    rpcMap,
    metadata: {
      name: APP_NAME,
      description: APP_DESCRIPTION,
      url: APP_URL,
      icons: APP_ICONS,
    },
    showQrModal: true,
    methods: [
      'eth_requestAccounts',
      'eth_chainId',
      'personal_sign',
      'eth_sendTransaction',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
    ],
  }
}

/** WalletConnect v2 via @walletconnect/ethereum-provider. */
export async function connectWalletConnect(): Promise<WalletHandle | null> {
  const options = walletConnectOptions()
  if (!options) return null
  // WalletConnect is an optional path. Keep its SDK out of the first paid-app
  // parse/evaluation path until the player explicitly chooses the button.
  const { default: EthereumProvider } = await import('@walletconnect/ethereum-provider')
  const provider = await EthereumProvider.init(options)
  await provider.enable()
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accounts || accounts.length === 0) return null
  const address = accounts[0]
  const chainId = Number((await provider.request({ method: 'eth_chainId' })) as string)
  return {
    address,
    chainId,
    client: createWalletClient({
      chain: chainFor(chainId),
      transport: custom(provider as EIP1193Provider),
    }),
    provider: provider as EIP1193Provider,
  }
}

/** Standard addEthereumChain params for the supported chains (from config). */
export function chainParams(chainId: number): {
  chainId: Hex
  chainName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  rpcUrls: string[]
  blockExplorerUrls?: string[]
} {
  const explorer = explorerUrlFor(chainId)
  const rpcUrl = rpcUrlFor(chainId)
  if (!rpcUrl) {
    throw new Error('RPC URL is not configured for chain ' + chainId + '.')
  }
  return {
    chainId: ('0x' + chainId.toString(16)) as Hex,
    chainName:
      chainId === 46630
        ? 'Robinhood Chain Testnet'
        : chainId === 4663
          ? 'Robinhood Chain'
          : 'Local EVM',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [rpcUrl],
    ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
  }
}

/**
 * Asks the wallet to switch chains; when the wallet does not know the chain
 * yet, adds it via wallet_addEthereumChain (correct chain id/RPC/explorer
 * from config) and then switches. Returns false when the user declines.
 */
export async function switchChain(provider: EIP1193Provider, chainId: number): Promise<boolean> {
  const switchParams: [{ chainId: Hex }] = [{ chainId: ('0x' + chainId.toString(16)) as Hex }]
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: switchParams })
    return true
  } catch {
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [chainParams(chainId)] })
      await provider.request({ method: 'wallet_switchEthereumChain', params: switchParams })
      return true
    } catch {
      return false
    }
  }
}

/** Re-reads the wallet's current chain and rebuilds the handle on it. */
export async function refreshChain(handle: WalletHandle): Promise<WalletHandle> {
  const chainId = Number((await handle.provider.request({ method: 'eth_chainId' })) as string)
  return {
    ...handle,
    chainId,
    client: createWalletClient({ chain: chainFor(chainId), transport: custom(handle.provider) }),
  }
}
