import { afterAll, describe, expect, it, vi } from 'vitest'

vi.stubEnv('VITE_WC_PROJECT_ID', 'mainnet-guard-test')
vi.stubEnv('VITE_RPC_URL', 'http://127.0.0.1:8545')
vi.stubEnv('VITE_RPC_URL_46630', 'https://rpc.testnet-46630.example')
vi.stubEnv('VITE_RPC_URL_4663', '')

const { chainFor, chainParams, walletConnectOptions } = await import('../paid/wallet')
const { isRpcConfigured, rpcUrlFor } = await import('../paid/config')

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('mainnet RPC fail-closed configuration', () => {
  it('never routes chain 4663 to the localhost RPC fallback', () => {
    expect(rpcUrlFor(4663)).toBe('')
    expect(isRpcConfigured(4663)).toBe(false)
    expect(chainFor(4663).rpcUrls.default.http).toEqual([])
    expect(() => chainParams(4663)).toThrow(/RPC URL is not configured for chain 4663/i)
  })

  it('omits an unconfigured mainnet from WalletConnect options', () => {
    const options = walletConnectOptions()
    expect(options?.chains).not.toContain(4663)
    expect(options?.optionalChains).not.toContain(4663)
    expect(options?.rpcMap[4663]).toBeUndefined()
  })
})
