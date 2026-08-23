export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://127.0.0.1:8787'
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8545'
/** Official testnet/mainnet endpoints — testnet pinned from official Robinhood Chain docs (verified live). */
export const RPC_URL_46630 =
  import.meta.env.VITE_RPC_URL_46630 ?? 'https://rpc.testnet.chain.robinhood.com/rpc'
/**
 * Mainnet deliberately has no localhost fallback. A missing mainnet RPC must
 * disable mainnet wallet discovery/add-chain flows instead of routing a
 * chain-4663 wallet through a local node by accident.
 */
export const RPC_URL_4663 = String(import.meta.env.VITE_RPC_URL_4663 ?? '').trim()
/** Official block explorer URLs (testnet/mainnet) — testnet verified live. */
export const EXPLORER_URL_46630 = String(
  import.meta.env.VITE_EXPLORER_URL_46630 ?? 'https://explorer.testnet.chain.robinhood.com',
)
export const EXPLORER_URL_4663 = String(import.meta.env.VITE_EXPLORER_URL_4663 ?? '')
/**
 * WalletConnect (Reown Cloud) project id. This is a PUBLIC client-side
 * identifier — it ships in the bundle by design, not a secret. Overridable
 * via VITE_WC_PROJECT_ID for other deployments; the deployed app URL must be
 * whitelisted in the Reown Cloud dashboard.
 */
export const WC_PROJECT_ID =
  import.meta.env.VITE_WC_PROJECT_ID ?? 'c3e9e29fb78618286b8c419b8a497fbe'
export const APP_NAME = import.meta.env.VITE_APP_NAME ?? 'FRONG Catch'
export const APP_DESCRIPTION =
  import.meta.env.VITE_APP_DESCRIPTION ?? 'FRONG Catch — the paid skill game on Robinhood Chain'
export const APP_URL = import.meta.env.VITE_APP_URL ?? 'http://127.0.0.1:8080'
export const APP_ICONS = String(import.meta.env.VITE_APP_ICONS ?? '')
  .split(',')
  .map((icon) => icon.trim())
  .filter(Boolean)
export const SUPPORTED_CHAIN_IDS = [46630, 4663, 31337] as const
/** Privy embedded wallets + social login (app id from the Privy dashboard). */
export const PRIVY_APP_ID = String(import.meta.env.VITE_PRIVY_APP_ID ?? '')
export const PRIVY_LOGIN_METHODS = String(
  import.meta.env.VITE_PRIVY_LOGIN_METHODS ?? 'email,google',
)
  .split(',')
  .map((method) => method.trim())
  .filter(Boolean)
/**
 * How long the paid app waits for the embedded Privy wallet to appear after
 * the login modal opens (login() itself returns void and does not wait).
 * Env-overridable so tests can use a short window with real timers.
 */
export const PRIVY_WAIT_POLL_MS = Number(import.meta.env.VITE_PRIVY_WAIT_POLL_MS ?? 250)
export const PRIVY_WAIT_TIMEOUT_MS = Number(import.meta.env.VITE_PRIVY_WAIT_TIMEOUT_MS ?? 120_000)

function isSafeRpcUrl(chainId: number, value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    if (chainId === 46630 || chainId === 4663) {
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(hostname)
    }
    return true
  } catch {
    return false
  }
}

export function isRpcConfigured(chainId: number): boolean {
  return isSafeRpcUrl(chainId, rpcUrlFor(chainId))
}

export function rpcUrlFor(chainId: number): string {
  if (chainId === 46630) return RPC_URL_46630
  if (chainId === 4663) return RPC_URL_4663
  return RPC_URL
}

export function explorerUrlFor(chainId: number): string {
  if (chainId === 46630) return EXPLORER_URL_46630
  if (chainId === 4663) return EXPLORER_URL_4663
  return ''
}
