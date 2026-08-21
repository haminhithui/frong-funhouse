import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { privateKeyToAccount } from 'viem/accounts'
import { hexToString } from 'viem'
import type { Hex } from 'viem'
import PaidApp from '../paid/PaidApp'

// The Privy SDK is mocked in jsdom tests (no real Privy app); the enabled
// Privy path is covered in paidPrivy.test.tsx.
vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePrivy: () => ({
    ready: true,
    authenticated: false,
    login: async () => {},
    logout: async () => {},
    getAccessToken: async () => null,
  }),
  useWallets: () => ({ wallets: [] }),
  useLogin: () => ({ login: async () => {} }),
  getIdentityToken: async () => null,
}))

// Throwaway test key - a local fixture account, never a live wallet.
const PLAYER = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
)
const SERVER = 'http://127.0.0.1:8787'
const RPC = 'http://127.0.0.1:8545'
/** The build-time sim hash injected by vite.config define (same in vitest). */
const SIM_HASH = import.meta.env.VITE_SIM_BUILD_HASH ?? 'be'.repeat(32)

interface CallRecord {
  method: string
  params: unknown[]
}

/** Installs a stubbed EIP-1193 wallet. Signatures are REAL ECDSA (viem local account). */
function installStubWallet() {
  const calls: CallRecord[] = []
  const listeners: Record<string, Array<() => void>> = {}
  let sendCount = 0
  const provider = {
    on: (event: string, handler: () => void) => {
      ;(listeners[event] ??= []).push(handler)
    },
    removeListener: (event: string, handler: () => void) => {
      listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler)
    },
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params: params ?? [] })
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [PLAYER.address]
        case 'eth_chainId':
          return '0x7a69'
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null
        case 'eth_call':
          // Wallet-side allowance read: zero allowance -> the approve path runs.
          return '0x' + '00'.repeat(32)
        case 'personal_sign': {
          const [hex, address] = params as [string, string]
          expect(address.toLowerCase()).toBe(PLAYER.address.toLowerCase())
          return await PLAYER.signMessage({ message: hexToString(hex as Hex) })
        }
        case 'eth_sendTransaction':
          sendCount += 1
          return '0x' + String(sendCount).padStart(2, '0').repeat(32)
        default:
          throw new Error('unhandled wallet method: ' + method)
      }
    },
  }
  ;(window as unknown as { ethereum: unknown }).ethereum = provider
  return { calls, listeners }
}

function mockNetwork(
  mintSequence: string[] = ['queued', 'minted'],
  configBuildHash: string = SIM_HASH,
) {
  let mintPoll = 0
  const submits: Record<string, unknown>[] = []
  const rpcFetches: string[] = []
  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })

    if (url.startsWith(RPC)) {
      // P1: no raw RPC fetches may reach the client anymore - wallet state
      // reads go through the connected wallet provider. Record any stray hit.
      rpcFetches.push(url)
      throw new Error('unexpected raw RPC fetch: ' + url)
    }
    if (url === SERVER + '/api/config' && method === 'GET') {
      return json(200, {
        chainId: 31337,
        frong: '0x' + '11'.repeat(20),
        entry: '0x' + '22'.repeat(20),
        trophy: '0x' + '33'.repeat(20),
        feeAmount: '1000000000000000000000',
        countdownTicks: 1,
        durationTicks: 60,
        buildHash: configBuildHash,
      })
    }
    if (url === SERVER + '/api/challenge') {
      return json(200, { nonce: 'nonce-1', message: 'frong-challenge-message' })
    }
    if (url === SERVER + '/api/verify') {
      return json(200, { authToken: 'auth-token-1', expiresAt: Date.now() + 60000 })
    }
    if (url === SERVER + '/api/session') {
      return json(200, {
        sessionId: 'session-1',
        seed: 12345,
        buildHash: configBuildHash,
        expiresAt: Date.now() + 60000,
        countdownTicks: 1,
        durationTicks: 60,
      })
    }
    if (url === SERVER + '/api/submit') {
      submits.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return json(200, {
        status: 'accepted',
        tokenId: 1,
        tier: { index: 0, name: 'Tadpole', slug: 'tadpole' },
        score: 0,
        caught: 0,
        missed: 45,
      })
    }
    if (url === SERVER + '/api/status/1') {
      const status = mintSequence[Math.min(mintPoll, mintSequence.length - 1)]
      mintPoll += 1
      return json(200, {
        record: {
          tokenId: 1,
          status,
          tierName: 'Tadpole',
          score: 0,
          fliesCaught: 0,
          txHash: status === 'minted' ? '0x' + 'ef'.repeat(32) : null,
          uri: SERVER + '/metadata/1.json',
        },
      })
    }
    throw new Error('unhandled fetch: ' + method + ' ' + url)
  }
  vi.stubGlobal('fetch', handler)
  return { submits, rpcFetches }
}

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => null,
  })
  window.localStorage.clear()
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FRONG Catch paid app', () => {
  it('walks the full paid flow: connect -> verify -> pay -> run -> verify -> minted', async () => {
    const user = userEvent.setup()
    const wallet = installStubWallet()
    const { submits, rpcFetches } = mockNetwork()

    render(<PaidApp />)

    // W0 poster -> W1 attract
    expect(screen.getByRole('heading', { name: /FRONG Catch/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('heading', { name: 'One run. One trophy.' })).toBeInTheDocument()

    // W1 -> W2 connect
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('heading', { name: 'Connect your wallet' })).toBeInTheDocument()

    // WalletConnect is enabled with the wired Reown Cloud project id.
    expect(screen.getByRole('button', { name: 'Connect with WalletConnect' })).toBeEnabled()
    // Privy is enabled: the local .env carries the configured app id.
    expect(screen.getByRole('button', { name: 'Continue with Privy' })).toBeEnabled()

    // W2 -> W3 verify
    await user.click(screen.getByRole('button', { name: 'Connect injected wallet' }))
    expect(await screen.findByRole('heading', { name: 'Verify your wallet' })).toBeInTheDocument()

    // W3: real ECDSA signature over the server's exact challenge message.
    await user.click(screen.getByRole('button', { name: 'Sign to verify' }))
    expect(await screen.findByRole('heading', { name: 'Entry review' })).toBeInTheDocument()
    const personalSign = wallet.calls.filter((c) => c.method === 'personal_sign')
    expect(personalSign).toHaveLength(1)

    // W4 review: the non-refundable disclosure and exact fee are shown.
    expect(screen.getByText(/non-refundable/i)).toBeInTheDocument()
    expect(screen.getAllByText('1000 FRONG', { exact: false }).length).toBeGreaterThanOrEqual(2)

    // W5 pay: approve + play go out as real wallet transactions.
    await user.click(screen.getByRole('button', { name: /Pay .* and play/ }))
    expect(await screen.findByText(/Score/)).toBeInTheDocument()
    expect(document.querySelector('canvas')).not.toBeNull()
    const sends = wallet.calls.filter((c) => c.method === 'eth_sendTransaction')
    expect(sends.length).toBeGreaterThanOrEqual(2)

    // P1: wallet state reads go through the connected wallet, never a raw RPC fetch.
    expect(wallet.calls.some((c) => c.method === 'eth_call')).toBe(true)
    expect(rpcFetches).toHaveLength(0)
    // P2: the approve is for EXACTLY the current fee (1000 FRONG), never maxUint256.
    const approveTx = sends[0]?.params[0] as { data?: string } | undefined
    const feeHex = '0x' + (1000n * 10n ** 18n).toString(16).padStart(64, '0')
    // tx.data is 0x-prefixed selector+spender+amount; the amount is the last
    // 32 bytes (no 0x prefix inside data).
    expect(String(approveTx?.data ?? '').endsWith(feeHex.slice(2))).toBe(true)

    // W11-W14: run finishes, auto-submit, poll status, trophy minted.
    const trophy = await screen.findByRole('heading', { name: 'Tadpole' }, { timeout: 10_000 })
    expect(trophy).toBeInTheDocument()
    // The submit carries THIS build's sim hash for the server's build binding.
    expect(submits[0]?.buildHash).toBe(SIM_HASH)
    expect(screen.getByText('Trophy minted')).toBeInTheDocument()
    expect(screen.getByText(/0xefefefef/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play again' })).toBeInTheDocument()
  }, 30_000)

  it('shows the rejection screen when the mint comes back rejected', async () => {
    const user = userEvent.setup()
    installStubWallet()
    mockNetwork(['queued', 'rejected'])
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Connect injected wallet' }))
    await user.click(await screen.findByRole('button', { name: 'Sign to verify' }))
    await user.click(await screen.findByRole('button', { name: /Pay .* and play/ }))
    const rejected = await screen.findByRole(
      'heading',
      { name: 'Run not accepted' },
      { timeout: 10_000 },
    )
    expect(rejected).toBeInTheDocument()
  }, 30_000)

  it('shows a clear error when no injected wallet exists', async () => {
    const user = userEvent.setup()
    mockNetwork()
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Connect injected wallet' }))
    expect(await screen.findByText(/No injected wallet found/)).toBeInTheDocument()
  })

  it('links back to the free practice section on the fan page', async () => {
    mockNetwork()
    render(<PaidApp />)
    const practice = screen.getAllByRole('link', { name: /practice/i })
    expect(practice.length).toBeGreaterThan(0)
    expect(practice[0]).toHaveAttribute('href', '/#play')
  })

  it('blocks paid runs when the server build hash does not match this build', async () => {
    mockNetwork(['queued', 'minted'], 'be'.repeat(32))
    render(<PaidApp />)

    expect(
      await screen.findByText(/does not match the game server's verified simulation/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })

  it('starts at the attract screen when embedded and exits via callback', async () => {
    const user = userEvent.setup()
    const onExit = vi.fn()
    const onPractice = vi.fn()
    mockNetwork()
    render(<PaidApp embedded onExit={onExit} onPractice={onPractice} />)

    expect(screen.getByRole('heading', { name: 'One run. One trophy.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Free practice' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Free practice' }))
    expect(onPractice).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('resets the flow when the wallet account or chain changes (accountsChanged/chainChanged)', async () => {
    const user = userEvent.setup()
    const wallet = installStubWallet()
    mockNetwork()
    render(<PaidApp />)

    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Connect injected wallet' }))
    await user.click(await screen.findByRole('button', { name: 'Sign to verify' }))
    expect(await screen.findByRole('heading', { name: 'Entry review' })).toBeInTheDocument()

    await act(async () => {
      for (const handler of wallet.listeners.accountsChanged ?? []) handler()
    })
    expect(await screen.findByRole('heading', { name: 'Connect your wallet' })).toBeInTheDocument()
    expect(screen.getByText(/Wallet account or network changed/)).toBeInTheDocument()
  })
})
