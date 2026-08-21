import { afterAll, describe, expect, it, vi } from 'vitest'

// Stub the deployment env BEFORE the module loads (import.meta.env is read
// at module evaluation time, exactly like a real Vite build with .env).
vi.stubEnv('VITE_WC_PROJECT_ID', 'test-project-id')
vi.stubEnv('VITE_RPC_URL', 'http://127.0.0.1:8545')
vi.stubEnv('VITE_RPC_URL_46630', 'https://rpc.testnet-46630.example')
vi.stubEnv('VITE_RPC_URL_4663', 'https://rpc.mainnet-4663.example')
vi.stubEnv('VITE_APP_NAME', 'FRONG Catch Test')
vi.stubEnv('VITE_APP_DESCRIPTION', 'Test deployment')
vi.stubEnv('VITE_APP_URL', 'https://play.example.com')
vi.stubEnv(
  'VITE_APP_ICONS',
  'https://play.example.com/icon.png, https://play.example.com/icon2.png',
)

const { chainFor, walletConnectOptions, switchChain, chainParams, refreshChain } =
  await import('../paid/wallet')

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('WalletConnect wiring for real deployments', () => {
  it('builds complete options: project id, per-chain rpcMap, and app metadata', () => {
    const options = walletConnectOptions()
    expect(options).not.toBeNull()
    expect(options?.projectId).toBe('test-project-id')
    expect(options?.chains).toEqual([46630, 4663, 31337])
    // Wallets must be able to reach the custom chains — never left unset.
    expect(options?.rpcMap[46630]).toBe('https://rpc.testnet-46630.example')
    expect(options?.rpcMap[4663]).toBe('https://rpc.mainnet-4663.example')
    expect(options?.rpcMap[31337]).toBe('http://127.0.0.1:8545')
    // Metadata shown in the WalletConnect pairing modal.
    expect(options?.metadata).toEqual({
      name: 'FRONG Catch Test',
      description: 'Test deployment',
      url: 'https://play.example.com',
      icons: ['https://play.example.com/icon.png', 'https://play.example.com/icon2.png'],
    })
  })

  it('routes each chain to its configured RPC in the viem chain objects', () => {
    expect(chainFor(46630).rpcUrls.default.http[0]).toBe('https://rpc.testnet-46630.example')
    expect(chainFor(4663).rpcUrls.default.http[0]).toBe('https://rpc.mainnet-4663.example')
    expect(chainFor(31337).rpcUrls.default.http[0]).toBe('http://127.0.0.1:8545')
  })

  it('includes wallet_addEthereumChain in the WalletConnect methods', () => {
    expect(walletConnectOptions()?.methods).toContain('wallet_addEthereumChain')
  })
})

describe('chain switching and wallet lifecycle helpers', () => {
  interface StubProvider {
    calls: { method: string; params: unknown[] }[]
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  }

  function stubProvider(switchFailsFirst = false): StubProvider {
    const calls: { method: string; params: unknown[] }[] = []
    let switches = 0
    return {
      calls,
      request: async ({ method, params }) => {
        calls.push({ method, params: params ?? [] })
        if (method === 'wallet_switchEthereumChain') {
          switches += 1
          if (switchFailsFirst && switches === 1) throw new Error('chain not added')
          return null
        }
        if (method === 'wallet_addEthereumChain') return null
        if (method === 'eth_chainId') return '0xb626'
        throw new Error('unexpected method: ' + method)
      },
    }
  }

  it('adds the Robinhood testnet chain when the wallet does not know it, then switches', async () => {
    const provider = stubProvider(true)
    const ok = await switchChain(provider as unknown as Parameters<typeof switchChain>[0], 46630)
    expect(ok).toBe(true)
    const add = provider.calls.find((c) => c.method === 'wallet_addEthereumChain')
    expect(add).toBeDefined()
    const params = add?.params[0] as Record<string, unknown>
    expect(params.chainId).toBe('0xb626')
    expect(params.chainName).toBe('Robinhood Chain Testnet')
    expect(params.rpcUrls).toEqual(['https://rpc.testnet-46630.example'])
    expect(params.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 })
  })

  it('builds standard addEthereumChain params with the configured explorer', () => {
    const params = chainParams(46630)
    expect(params.chainId).toBe('0xb626')
    expect(params.rpcUrls).toEqual(['https://rpc.testnet-46630.example'])
    expect(params.blockExplorerUrls).toEqual(['https://explorer.testnet.chain.robinhood.com'])
  })

  it('re-reads the chain id when refreshing a wallet handle', async () => {
    const provider = stubProvider()
    const stale = {
      address: '0x' + 'aa'.repeat(20),
      chainId: 1,
      client: null,
      provider: provider as unknown as Parameters<typeof refreshChain>[0]['provider'],
    }
    const refreshed = await refreshChain(stale as unknown as Parameters<typeof refreshChain>[0])
    expect(refreshed.chainId).toBe(46630)
    expect(refreshed.client).not.toBeNull()
  })
})
