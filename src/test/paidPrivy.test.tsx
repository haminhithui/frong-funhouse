import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** The build-time sim hash injected by vite.config define (same in vitest). */
const SIM_HASH = import.meta.env.VITE_SIM_BUILD_HASH ?? 'be'.repeat(32)

// --- Privy SDK mock (hoisted: mock factories cannot close over outer vars) ---
//
// Mirrors the real v3 SDK contract: login() OPENS the modal and returns
// immediately; the embedded wallet appears in useWallets() only once the user
// completes the flow. The mock pushes the wallet into a mutable array so the
// hook's poller (which holds a ref to the same array) can observe it without
// a React re-render.
const privy = vi.hoisted(() => {
  const calls: string[] = []
  const chain = { id: '0x1' }
  const provider = {
    request: async ({ method }: { method: string; params?: unknown[] }) => {
      calls.push(method)
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc']
      }
      if (method === 'eth_chainId') return chain.id
      if (method === 'wallet_switchEthereumChain') {
        chain.id = '0x7a69'
        return null
      }
      if (method === 'wallet_addEthereumChain') return null
      throw new Error('unhandled method ' + method)
    },
  }
  const wallet = {
    address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
    chainId: 'eip155:1',
    walletClientType: 'privy',
    getEthereumProvider: vi.fn(async () => provider),
  }
  const state = { wallets: [] as (typeof wallet)[] }
  return {
    calls,
    chain,
    wallet,
    state,
    login: vi.fn(async () => {
      // Simulates the user completing the modal: the embedded wallet appears.
      state.wallets.push(wallet)
    }),
    logout: vi.fn(async () => {
      state.wallets.length = 0
    }),
    getAccessToken: vi.fn(async (): Promise<string | null> => 'privy-access-token'),
  }
})

vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    login: privy.login,
    logout: privy.logout,
    getAccessToken: privy.getAccessToken,
  }),
  getIdentityToken: async () => 'privy-id-token',
  useWallets: () => ({ wallets: privy.state.wallets }),
  useLogin: ({
    onComplete,
    onError,
  }: {
    onComplete?: (params: unknown) => void
    onError?: (code: unknown) => void
  }) => ({
    login: async () => {
      try {
        await privy.login()
        onComplete?.({
          user: {},
          isNewUser: true,
          wasAlreadyAuthenticated: false,
          loginMethod: 'email',
          loginAccount: null,
        })
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error))
      }
    },
  }),
}))

const SERVER = 'http://127.0.0.1:8787'

/** Every body the paid app POSTs to /api/verify/privy, for shape assertions. */
const privyVerifyBodies: Record<string, string>[] = []

vi.stubEnv('VITE_PRIVY_APP_ID', 'privy-app-id-123')
vi.stubEnv('VITE_SERVER_URL', SERVER)
// Short wait window so the timeout path can be tested with real timers.
vi.stubEnv('VITE_PRIVY_WAIT_TIMEOUT_MS', '500')

const { default: PaidApp } = await import('../paid/PaidApp')

function mockNetwork() {
  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    if (url === SERVER + '/api/config' && method === 'GET') {
      return json(200, {
        chainId: 31337,
        frong: '0x' + '11'.repeat(20),
        entry: '0x' + '22'.repeat(20),
        trophy: '0x' + '33'.repeat(20),
        feeAmount: '10000000000000000000',
        countdownTicks: 1,
        durationTicks: 60,
        buildHash: SIM_HASH,
      })
    }
    if (url === SERVER + '/api/verify/privy') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        accessToken?: string
        idToken?: string
      }
      privyVerifyBodies.push(body as Record<string, string>)
      return body.accessToken === 'privy-access-token' && body.idToken === 'privy-id-token'
        ? json(200, {
            authToken: 'b'.repeat(64),
            expiresAt: Date.now() + 60000,
            address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
          })
        : json(401, { error: 'Privy verification failed' })
    }
    throw new Error('unhandled fetch: ' + method + ' ' + url)
  }
  vi.stubGlobal('fetch', handler)
}

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => null,
  })
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  privy.calls.length = 0
  privy.chain.id = '0x1'
  privy.wallet.chainId = 'eip155:1'
  privy.state.wallets.length = 0
  privy.login.mockClear()
  privy.logout.mockClear()
  privy.getAccessToken.mockClear()
  privyVerifyBodies.length = 0
})

async function clickPrivy(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('button', { name: 'Continue with Privy' })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Continue with Privy' })).toBeEnabled(),
  )
  await user.click(screen.getByRole('button', { name: 'Continue with Privy' }))
}

describe('FRONG Catch paid app — Privy login', () => {
  it('surfaces a login failure instead of failing silently', async () => {
    const user = userEvent.setup()
    mockNetwork()
    privy.login.mockRejectedValueOnce(new Error('user closed the login modal'))
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))

    await clickPrivy(user)
    expect(
      await screen.findByText(/Privy login failed/i, {}, { timeout: 8000 }),
    ).toBeInTheDocument()
  })

  it('surfaces a server-unreachable error after a successful Privy login', async () => {
    const user = userEvent.setup()
    mockNetwork()
    // The verify endpoint's network layer fails (server down) — replace the
    // stub with one whose /api/verify/privy route throws like a dead server.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === SERVER + '/api/verify/privy') {
        throw new TypeError('fetch failed')
      }
      if (url === SERVER + '/api/config') {
        return new Response(
          JSON.stringify({
            chainId: 31337,
            frong: '0x' + '11'.repeat(20),
            entry: '0x' + '22'.repeat(20),
            trophy: '0x' + '33'.repeat(20),
            feeAmount: '10000000000000000000',
            countdownTicks: 1,
            durationTicks: 60,
            buildHash: SIM_HASH,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error('unhandled fetch: ' + url)
    })
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))

    await clickPrivy(user)
    expect(
      await screen.findByText(/Could not reach the game server/i, {}, { timeout: 8000 }),
    ).toBeInTheDocument()
  })

  it('waits for the embedded wallet to appear after login opens the modal', async () => {
    const user = userEvent.setup()
    mockNetwork()
    // The real v3 SDK: login() opens the modal and returns immediately — the
    // embedded wallet only exists once the user completes the form. The app
    // must KEEP WAITING instead of failing with "did not create a wallet".
    privy.login.mockImplementationOnce(async () => {
      setTimeout(() => privy.state.wallets.push(privy.wallet), 100)
    })
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))

    await clickPrivy(user)
    expect(
      await screen.findByRole('heading', { name: 'Entry review' }, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(privy.login).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/did not create a wallet/i)).not.toBeInTheDocument()
  })

  it('gives up with a clear error when no wallet ever appears', async () => {
    const user = userEvent.setup()
    mockNetwork()
    // The modal opens but the user never completes it — the wallet never
    // appears. With the shortened VITE_PRIVY_WAIT_TIMEOUT_MS window the app
    // must surface a clear error instead of hanging forever.
    privy.login.mockImplementationOnce(async () => {})
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))

    await clickPrivy(user)
    expect(
      await screen.findByText(/Privy login did not complete/i, {}, { timeout: 8000 }),
    ).toBeInTheDocument()
  }, 15000)

  it('offers all three connect methods: injected, WalletConnect, and Privy', async () => {
    const user = userEvent.setup()
    mockNetwork()
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('button', { name: 'Connect injected wallet' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect with WalletConnect' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue with Privy' })).toBeEnabled()
  })

  it('logs in with Privy, verifies server-side, and lands on the entry review', async () => {
    const user = userEvent.setup()
    mockNetwork()
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))

    await clickPrivy(user)
    expect(
      await screen.findByRole('heading', { name: 'Entry review' }, { timeout: 8000 }),
    ).toBeInTheDocument()

    // Privy login ran, the access token was sent to the server, and the
    // review screen shows the embedded wallet address.
    expect(privy.login).toHaveBeenCalledTimes(1)
    expect(privy.getAccessToken).toHaveBeenCalledTimes(1)
    expect(privy.wallet.getEthereumProvider).toHaveBeenCalled()
    expect(privy.calls).toContain('wallet_switchEthereumChain')
    expect(screen.getByText(/non-refundable/i)).toBeInTheDocument()
    expect(screen.getByText(/0x3c44/i)).toBeInTheDocument()
  })

  it('sends the real request shape: address + access token + identity token', async () => {
    const user = userEvent.setup()
    mockNetwork()
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))

    await clickPrivy(user)
    await screen.findByRole('heading', { name: 'Entry review' }, { timeout: 8000 })

    // The server needs BOTH tokens: the access token (signature verification)
    // and the identity token (wallet linkage from linked_accounts).
    expect(privyVerifyBodies).toHaveLength(1)
    expect(privyVerifyBodies[0]).toEqual({
      address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
      accessToken: 'privy-access-token',
      idToken: 'privy-id-token',
    })
  })
})
