import { useState } from 'react'
import { PrivyProvider } from '@privy-io/react-auth'
import { PRIVY_APP_ID, PRIVY_LOGIN_METHODS } from './config'
import { chainFor } from './wallet'
import { usePrivyLogin } from './usePrivyLogin'
import type { PrivyConnectControlProps } from './privy'
import type { PrivyLoginMethod } from './usePrivyLogin'

function PrivyRuntimeButton({ busy, onConnect, onError, buttonClass }: PrivyConnectControlProps) {
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

export function PrivyRuntimeControl(props: PrivyConnectControlProps) {
  if (!PRIVY_APP_ID) return null
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
      <PrivyRuntimeButton {...props} />
    </PrivyProvider>
  )
}
