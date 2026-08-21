import { useCallback, useRef } from 'react'
import { getIdentityToken, useLogin, usePrivy, useWallets } from '@privy-io/react-auth'
import { createWalletClient, custom } from 'viem'
import type { EIP1193Provider } from 'viem'
import { chainFor } from './wallet'
import type { WalletHandle } from './wallet'
import { PRIVY_WAIT_POLL_MS, PRIVY_WAIT_TIMEOUT_MS } from './config'

export type PrivyLoginMethod =
  | 'wallet'
  | 'email'
  | 'sms'
  | 'google'
  | 'twitter'
  | 'discord'
  | 'github'
  | 'linkedin'
  | 'spotify'
  | 'instagram'
  | 'tiktok'
  | 'line'
  | 'twitch'
  | 'apple'
  | 'farcaster'
  | 'telegram'
  | 'passkey'

export interface PrivyHandle {
  wallet: WalletHandle
  accessToken: string
  /** Privy identity token — carries the linked_accounts claim for server linkage checks. */
  idToken: string
}

export interface PrivyLoginState {
  ready: boolean
  authenticated: boolean
  connect: () => Promise<PrivyHandle>
  disconnect: () => Promise<void>
}

interface PrivyWallet {
  address: string
  chainId: string
  walletClientType: string
  getEthereumProvider: () => Promise<unknown>
}

/**
 * In @privy-io/react-auth v3, login() only OPENS the modal and returns void —
 * it does not wait for the user to finish. Completion arrives through the
 * useLogin callbacks, and the wallet appears in useWallets() only after the
 * user actually logs in. Reading wallets right after login() (the old code)
 * always saw an empty list and aborted while the modal was still open.
 *
 */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Builds the game WalletHandle from a Privy wallet + the TWO Privy tokens
 * (access token for signature verification, identity token for wallet
 * linkage). Every failure path THROWS a readable error — the UI must surface
 * it, never fail silently.
 */
async function buildHandle(
  wallet: PrivyWallet | undefined,
  accessToken: string | null,
  idToken: string | null,
): Promise<PrivyHandle> {
  if (!wallet) throw new Error('Privy did not create a wallet — check the dashboard settings.')
  if (!accessToken) throw new Error('Privy login did not produce an access token.')
  if (!idToken) throw new Error('Privy login did not produce an identity token.')
  const provider = (await wallet.getEthereumProvider()) as EIP1193Provider
  const chainId = Number(String(wallet.chainId).split(':').pop())
  if (!Number.isFinite(chainId)) {
    throw new Error('Privy wallet reported an unreadable chain id.')
  }
  return {
    wallet: {
      address: wallet.address,
      chainId,
      client: createWalletClient({
        chain: chainFor(chainId),
        transport: custom(provider),
      }),
      provider,
    },
    accessToken,
    idToken,
  }
}

/** Must be used inside PrivyLoginProvider (i.e. only when an app id is configured). */
export function usePrivyLogin(): PrivyLoginState {
  const { ready, authenticated, logout, getAccessToken } = usePrivy()
  const { wallets } = useWallets()

  // Refs so the long-lived poller and the SDK callbacks always see the
  // LATEST hook values instead of the render-time snapshot.
  const walletsRef = useRef(wallets)
  walletsRef.current = wallets
  const getTokenRef = useRef(getAccessToken)
  getTokenRef.current = getAccessToken
  const getIdTokenRef = useRef(getIdentityToken)
  getIdTokenRef.current = getIdentityToken
  const logoutRef = useRef(logout)
  logoutRef.current = logout

  // Latest handlers, dispatched through refs so useLogin callbacks never go
  // stale between renders.
  const onCompleteRef = useRef<() => void>(() => {})
  const onErrorRef = useRef<(code: unknown) => void>(() => {})

  const { login } = useLogin({
    onComplete: () => onCompleteRef.current(),
    onError: (code: unknown) => onErrorRef.current(code),
  })

  const connect = useCallback(async (): Promise<PrivyHandle> => {
    // Fast path: a resumed session already has its embedded wallet + token, so
    // there is nothing to ask the user for.
    const existing =
      walletsRef.current.find((w) => w.walletClientType === 'privy') ?? walletsRef.current[0]
    if (existing) {
      const token = await getTokenRef.current()
      const idToken = await getIdTokenRef.current()
      if (token && idToken) return await buildHandle(existing, token, idToken)
      // Half-session (wallet without both tokens): sign out so the modal starts clean.
      try {
        await logoutRef.current()
      } catch {
        // A stale session can fail to log out; the fresh login below still works.
      }
    }

    return await new Promise<PrivyHandle>((resolve, reject) => {
      let settled = false
      let interval: ReturnType<typeof setInterval> | null = null

      const finish = (error: Error | null, handle?: PrivyHandle) => {
        if (settled) return
        settled = true
        if (interval) clearInterval(interval)
        if (error) reject(error)
        else if (handle) resolve(handle)
      }

      // Check whether the embedded wallet and BOTH tokens are available yet.
      const check = () => {
        void (async () => {
          const wallet =
            walletsRef.current.find((w) => w.walletClientType === 'privy') ?? walletsRef.current[0]
          if (!wallet) return
          const token = await getTokenRef.current()
          if (!token) return
          const idToken = await getIdTokenRef.current()
          if (!idToken) return
          try {
            finish(null, await buildHandle(wallet, token, idToken))
          } catch (error) {
            finish(toError(error))
          }
        })()
      }

      onCompleteRef.current = () => check()
      onErrorRef.current = (code: unknown) => {
        finish(new Error('Privy login failed: ' + String(code)))
      }

      try {
        // Opens the Privy modal. Returns void — completion is observed via
        // onComplete/onError and the wallet poll below.
        login()
      } catch (error) {
        finish(new Error('Privy login failed: ' + toError(error).message))
        return
      }

      const deadline = Date.now() + PRIVY_WAIT_TIMEOUT_MS
      interval = setInterval(() => {
        check()
        if (Date.now() > deadline) {
          finish(
            new Error(
              'Privy login did not complete. If you closed the window, click Continue again.',
            ),
          )
        }
      }, PRIVY_WAIT_POLL_MS)
    })
  }, [login])

  const disconnect = useCallback(() => logout(), [logout])
  return { ready, authenticated, connect, disconnect }
}
