import { useState } from 'react'
import type { ReactNode } from 'react'
import { PrivyProvider } from '@privy-io/react-auth'
import { PRIVY_APP_ID, PRIVY_LOGIN_METHODS } from './config'
import { chainFor } from './wallet'
import { usePrivyLogin } from './usePrivyLogin'
import type { PrivyHandle, PrivyLoginMethod } from './usePrivyLogin'

/**
 * Wraps the app in PrivyProvider only when VITE_PRIVY_APP_ID is configured —
 * without it the Privy button is disabled and nothing loads the SDK UI.
 */
export function PrivyLoginProvider({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <>{children}</>
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: PRIVY_LOGIN_METHODS as PrivyLoginMethod[],
        appearance: { theme: 'dark', accentColor: '#9cdb62' },
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        defaultChain: chainFor(46630),
        supportedChains: [chainFor(46630), chainFor(4663), chainFor(31337)],
      }}
    >
      {children}
    </PrivyProvider>
  )
}

export interface PrivyConnectControlProps {
  busy: boolean
  onConnect: (handle: PrivyHandle) => void
  onError: (message: string) => void
  buttonClass: string
  helpClass: string
}

function PrivyConnectButton({ busy, onConnect, onError, buttonClass }: PrivyConnectControlProps) {
  const privy = usePrivyLogin()
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      className={buttonClass}
      disabled={busy || pending || !privy.ready}
      onClick={() => {
        setPending(true)
        privy
          .connect()
          .then((handle) => onConnect(handle))
          .catch((error: unknown) => {
            onError(error instanceof Error ? error.message : String(error))
          })
          .finally(() => setPending(false))
      }}
    >
      {pending ? 'Waiting for Privy…' : 'Continue with Privy'}
    </button>
  )
}

/**
 * Renders the Privy login button. Without a configured app id it is disabled
 * with a note — never fake-connected.
 */
export function PrivyConnectControl(props: PrivyConnectControlProps) {
  if (!PRIVY_APP_ID) {
    return (
      <>
        <button type="button" className={props.buttonClass} disabled>
          Continue with Privy
        </button>
        <p className={props.helpClass}>Privy login needs VITE_PRIVY_APP_ID to be configured.</p>
      </>
    )
  }
  return <PrivyConnectButton {...props} />
}
