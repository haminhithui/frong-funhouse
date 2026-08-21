import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** The build-time sim hash injected by vite.config define (same in vitest). */
const SIM_HASH = import.meta.env.VITE_SIM_BUILD_HASH ?? 'be'.repeat(32)

// Disabled posture: no Privy app id configured. Stubbed BEFORE module load.
vi.stubEnv('VITE_PRIVY_APP_ID', '')

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

const { default: PaidApp } = await import('../paid/PaidApp')

function mockNetwork() {
  const handler = async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === 'http://127.0.0.1:8787/api/config') {
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
})

describe('FRONG Catch paid app — Privy disabled without app id', () => {
  it('disables the Privy button and shows the configuration note', async () => {
    const user = userEvent.setup()
    mockNetwork()
    render(<PaidApp />)
    await user.click(screen.getByRole('button', { name: 'Play' }))
    await user.click(screen.getByRole('button', { name: 'Play' }))

    expect(screen.getByRole('button', { name: 'Continue with Privy' })).toBeDisabled()
    expect(screen.getByText(/Privy login needs VITE_PRIVY_APP_ID/)).toBeInTheDocument()
  })
})
