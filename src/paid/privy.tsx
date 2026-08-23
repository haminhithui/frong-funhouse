import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { PRIVY_APP_ID } from './config'
import type { PrivyHandle } from './usePrivyLogin'

export interface PrivyConnectControlProps {
  busy: boolean
  onConnect: (handle: PrivyHandle) => void
  onError: (message: string) => void
  buttonClass: string
  helpClass: string
}

const LazyPrivyControl = lazy(async () => {
  const module = await import('./privyRuntime')
  return { default: module.PrivyRuntimeControl }
})

/**
 * Privy is optional and expensive. The provider is mounted inside the lazy
 * control, so the SDK is not downloaded on the poster/attract/free-practice
 * path and is never initialized when no app id is configured.
 */
export function PrivyLoginProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

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
  return (
    <Suspense
      fallback={
        <button type="button" className={props.buttonClass} disabled>
          Continue with Privy
        </button>
      }
    >
      <LazyPrivyControl {...props} />
    </Suspense>
  )
}
