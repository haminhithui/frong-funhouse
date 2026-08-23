import { useCallback, useEffect, useRef, useState } from 'react'
import { createPublicClient, custom, formatEther, parseAbi } from 'viem'
import type { Address } from 'viem'
import arcade from '../game/arcade.module.css'
import { CanvasStage } from '../game/CanvasStage'
import type { HudSnapshot, InputFrame, RunResult } from '../game/CanvasStage'
import { FlyGlyph } from '../game/FlyGlyph'
import { FLY_LABELS, FLY_NOTES, FLY_TYPE_IDS } from '../game/flyCopy'
import { Spinner } from '../game/Spinner'
import { TICKS_PER_SECOND, TIERS, tierForScore } from '../game/sim/constants'
import { TIER_FLAVOR } from '../game/tierCopy'
import { loadBestScore } from '../game/util'
import { usePrefersReducedMotion } from '../game/usePrefersReducedMotion'
import { WC_PROJECT_ID, explorerUrlFor } from './config'
import { PrivyConnectControl, PrivyLoginProvider } from './privy'
import type { PrivyHandle } from './usePrivyLogin'
import { hashInputLog, newPaymentId } from './log'
import * as api from './api'
import type { GameConfigResponse, MintStatusResponse, SessionResponse } from './api'
import {
  clearPendingPayment,
  loadPendingPayment,
  savePendingPayment,
  type PendingPayment,
} from './paymentRecovery'
import {
  chainFor,
  connectInjected,
  connectWalletConnect,
  refreshChain,
  switchChain,
} from './wallet'
import type { WalletHandle } from './wallet'
import styles from './PaidApp.module.css'

type Screen =
  | 'poster'
  | 'attract'
  | 'connect'
  | 'verify'
  | 'review'
  | 'paying'
  | 'preparing'
  | 'payment-recovery'
  | 'payment-failed'
  | 'run'
  | 'results'
  | 'minting'
  | 'minted'
  | 'rejected'
  | 'delayed'

type ConfigStatus = 'loading' | 'ready' | 'error'

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const ENTRY_ABI = parseAbi(['function play(bytes32 paymentId)'])

const POLL_MS = 1_200

/** Small vector glyphs for state boxes — semantics from shape, never color alone. */
const ALERT_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line
      x1="8"
      y1="4.5"
      x2="8"
      y2="9"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
  </svg>
)

const WARN_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M8 2 L15 14 L1 14 Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <line
      x1="8"
      y1="6"
      x2="8"
      y2="10"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <circle cx="8" cy="12" r="0.9" fill="currentColor" />
  </svg>
)

interface PaidAppProps {
  /** Embedded inside the fan page: no page chrome, starts at the attract screen. */
  embedded?: boolean
  /** Called when the player leaves the paid flow (embedded mode). */
  onExit?: () => void
  /** Called when the player switches to free practice (embedded mode). */
  onPractice?: () => void
}

export default function PaidApp({ embedded = false, onExit, onPractice }: PaidAppProps) {
  const [screen, setScreen] = useState<Screen>(embedded ? 'attract' : 'poster')
  const [gameConfig, setGameConfig] = useState<GameConfigResponse | null>(null)
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading')
  const [configError, setConfigError] = useState<string | null>(null)
  const [buildMismatch, setBuildMismatch] = useState(false)
  const [wallet, setWallet] = useState<WalletHandle | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(() =>
    loadPendingPayment(),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prepareError, setPrepareError] = useState<string | null>(null)
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [runId, setRunId] = useState(0)
  const [seed, setSeed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hud, setHud] = useState<HudSnapshot>({
    phase: 'countdown',
    countdownLeft: 180,
    score: 0,
    caught: 0,
    timeLeft: 60,
  })
  const [result, setResult] = useState<RunResult | null>(null)
  const [tokenId, setTokenId] = useState<number | null>(null)
  const [mint, setMint] = useState<MintStatusResponse['record'] | null>(null)
  const [rejectReason, setRejectReason] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const [best] = useState(() => loadBestScore())
  const headingRef = useRef<HTMLElement | null>(null)
  const pauseCardRef = useRef<HTMLDivElement | null>(null)
  const prevScreenRef = useRef<Screen>(embedded ? 'attract' : 'poster')
  const configRequestRef = useRef(0)
  const reducedMotion = usePrefersReducedMotion()

  const loadGameConfig = useCallback(async () => {
    const requestId = configRequestRef.current + 1
    configRequestRef.current = requestId
    setConfigStatus('loading')
    setConfigError(null)
    setGameConfig(null)
    setBuildMismatch(false)
    try {
      const config = await api.fetchGameConfig()
      if (configRequestRef.current !== requestId) return
      setGameConfig(config)
      setBuildMismatch(config.buildHash !== import.meta.env.VITE_SIM_BUILD_HASH)
      setConfigStatus('ready')
    } catch (loadError) {
      if (configRequestRef.current !== requestId) return
      setConfigStatus('error')
      setConfigError(
        loadError instanceof api.ApiRequestError && loadError.status !== null
          ? `Game server returned HTTP ${loadError.status}. Paid runs are disabled.`
          : 'Game server unavailable. Paid runs are disabled.',
      )
    }
  }, [])

  useEffect(() => {
    void loadGameConfig()
    return () => {
      configRequestRef.current += 1
    }
  }, [loadGameConfig])

  const paidFlowReady = configStatus === 'ready' && gameConfig !== null && !buildMismatch
  const paidBlockedReason =
    configStatus === 'loading'
      ? 'Checking game server configuration. Paid runs are disabled until it is ready.'
      : configStatus === 'error'
        ? (configError ?? 'Game server unavailable. Paid runs are disabled.')
        : buildMismatch
          ? "This build does not match the game server's verified simulation. Paid runs are disabled."
          : 'Paid game configuration is unavailable. Paid runs are disabled.'

  // Focus the new screen's heading on every transition.
  useEffect(() => {
    if (screen !== prevScreenRef.current) {
      headingRef.current?.focus()
      prevScreenRef.current = screen
    }
  }, [screen])

  // Poll mint status while minting/delayed-check.
  useEffect(() => {
    if ((screen !== 'minting' && screen !== 'delayed') || tokenId === null || !authToken) {
      return
    }
    let cancelled = false
    const poll = () => {
      api
        .fetchMintStatus(tokenId, authToken)
        .then((status) => {
          if (cancelled) return
          setMint(status.record)
          if (status.record.status === 'minted') {
            setScreen('minted')
            setAnnounce('Trophy minted. Check your wallet.')
          } else if (status.record.status === 'delayed') {
            setScreen('delayed')
            setAnnounce('Run verified. Mint queued and will arrive shortly.')
          } else if (status.record.status === 'rejected') {
            setRejectReason('The server could not mint this trophy.')
            setScreen('rejected')
            setAnnounce('Mint failed. No trophy was minted.')
          }
        })
        .catch(() => {
          // Transient polling failure; keep waiting.
        })
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [authToken, screen, tokenId])

  const connect = useCallback(
    async (kind: 'injected' | 'wc') => {
      setBusy(true)
      setError(null)
      try {
        if (!paidFlowReady || !gameConfig) {
          setError(paidBlockedReason)
          setScreen('attract')
          return
        }
        const handle = kind === 'injected' ? await connectInjected() : await connectWalletConnect()
        if (!handle) {
          setError(
            kind === 'injected'
              ? 'No injected wallet found. Install a wallet extension and try again.'
              : 'WalletConnect is not configured (missing project id).',
          )
          return
        }
        const expected = gameConfig?.chainId
        if (expected !== undefined && handle.chainId !== expected) {
          const switched = await switchChain(handle.provider, expected)
          if (!switched) {
            setError('Wrong network. Please switch your wallet to chain ' + expected + '.')
            return
          }
        }
        // Re-read the chain AFTER a possible switch so the stored handle
        // never carries a stale chain id.
        setWallet(await refreshChain(handle))
        setAnnounce('Wallet connected.')
        setScreen('verify')
      } catch (connectError) {
        setError(
          'Wallet connection failed: ' +
            (connectError instanceof Error ? connectError.message : String(connectError)),
        )
      } finally {
        setBusy(false)
      }
    },
    [gameConfig, paidBlockedReason, paidFlowReady],
  )

  const signVerify = useCallback(async () => {
    if (!wallet) {
      setError('Connect a wallet before signing the verification message.')
      setScreen('connect')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const challenge = await api.fetchChallenge(wallet.address)
      if (challenge.status !== 200 || 'error' in challenge.body) {
        setError('Could not start verification. Is the server reachable?')
        return
      }
      const signature = await wallet.client.signMessage({
        account: wallet.address as Address,
        message: challenge.body.message,
      })
      const verify = await api.verifyWallet(wallet.address, challenge.body.nonce, signature)
      if (verify.status !== 200 || 'error' in verify.body) {
        setError('Signature verification failed. Try again.')
        return
      }
      setAuthToken(verify.body.authToken)
      setAnnounce('Wallet verified.')
      const hasRecoverablePayment =
        pendingPayment !== null &&
        pendingPayment.player.toLowerCase() === wallet.address.toLowerCase()
      if (hasRecoverablePayment && pendingPayment.chainId === wallet.chainId) {
        setScreen('payment-recovery')
      } else {
        setScreen('review')
      }
    } catch (verifyError) {
      setError(
        'Wallet verification failed: ' +
          (verifyError instanceof Error ? verifyError.message : String(verifyError)),
      )
    } finally {
      setBusy(false)
    }
  }, [pendingPayment, wallet])

  // P or Escape toggles pause during a run.
  useEffect(() => {
    if (screen !== 'run') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'p' || event.key === 'P' || event.key === 'Escape') {
        setPaused((p) => !p)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [screen])

  // Pause dialog: focus Resume on open, trap Tab inside, return focus on close.
  useEffect(() => {
    if (screen !== 'run') return
    if (paused) {
      pauseCardRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Tab') return
        const card = pauseCardRef.current
        if (!card) return
        const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>('button'))
        if (buttons.length === 0) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }
    headingRef.current?.focus()
  }, [paused, screen])

  // Auto-pause when the page loses focus or the tab is hidden.
  useEffect(() => {
    if (screen !== 'run') return
    const onBlur = () => setPaused(true)
    const onVisibility = () => {
      if (document.hidden) setPaused(true)
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [screen])

  // Wallet lifecycle (P3): any account or chain change resets the flow and
  // forces a fresh connect/verify — a stale verified wallet never plays.
  useEffect(() => {
    if (!wallet) return
    const provider = wallet.provider as unknown as {
      on?: (event: string, handler: () => void) => void
      removeListener?: (event: string, handler: () => void) => void
    }
    const onChange = () => {
      setWallet(null)
      setAuthToken(null)
      setSession(null)
      setError('Wallet account or network changed. Connect again to continue.')
      setAnnounce('Wallet changed. Connect again to continue.')
      setScreen('connect')
    }
    provider.on?.('accountsChanged', onChange)
    provider.on?.('chainChanged', onChange)
    return () => {
      provider.removeListener?.('accountsChanged', onChange)
      provider.removeListener?.('chainChanged', onChange)
    }
  }, [wallet])

  const startRun = useCallback((nextSession: SessionResponse) => {
    setSession(nextSession)
    setSeed(nextSession.seed)
    setRunId((n) => n + 1)
    setHud({
      phase: 'countdown',
      countdownLeft: nextSession.countdownTicks,
      score: 0,
      caught: 0,
      timeLeft: Math.ceil(nextSession.durationTicks / TICKS_PER_SECOND),
    })
    setAnnounce('Run started. Move the lily pad and catch as many flies as you can.')
    setScreen('run')
  }, [])

  const recoverPayment = useCallback(
    async (payment: PendingPayment) => {
      if (!authToken) {
        setError('Verify your wallet before recovering the submitted payment.')
        setScreen('verify')
        return
      }
      setBusy(true)
      setError(null)
      setPrepareError(null)
      setScreen('preparing')
      try {
        let sessionResponse: Awaited<ReturnType<typeof api.requestSession>> | null = null
        for (let attempt = 0; attempt < 10; attempt += 1) {
          sessionResponse = await api.requestSession(authToken, payment.txHash, payment.paymentId)
          if (
            sessionResponse.status === 200 &&
            !('error' in sessionResponse.body) &&
            !('consumed' in sessionResponse.body && sessionResponse.body.consumed === true)
          ) {
            // Keep the payment marker until the server accepts the run. A
            // browser crash between session recovery and the first game tick
            // must not make the wallet look unpaid and offer a second charge.
            startRun(sessionResponse.body as SessionResponse)
            return
          }
          if (
            sessionResponse.status === 200 &&
            'consumed' in sessionResponse.body &&
            sessionResponse.body.consumed === true
          ) {
            // A crash can happen after the server accepts a run but before
            // the browser clears its local payment guard. The consumed
            // response is the durable proof that this marker is safe to
            // remove; otherwise the player would be blocked forever.
            clearPendingPayment()
            setPendingPayment(null)
            setPrepareError(null)
            setError('This payment already completed its run. You can start a new paid run.')
            setScreen('review')
            return
          }
          const reason =
            'reason' in sessionResponse.body
              ? (sessionResponse.body as { reason?: string }).reason
              : undefined
          if (reason !== 'transaction not final yet' && sessionResponse.status < 500) break
          await new Promise((resolve) => setTimeout(resolve, 1_500))
        }
        const body = sessionResponse?.body as { error?: string; reason?: string } | undefined
        setPrepareError(
          body?.reason
            ? body.reason + '. Do not pay again; retry recovery.'
            : 'Payment was submitted but the server has not started the run. Do not pay again; retry recovery using the same transaction.',
        )
        setScreen('payment-recovery')
      } catch {
        setPrepareError(
          'Payment was submitted, but the server could not be reached. Do not pay again; retry recovery using the same transaction.',
        )
        setScreen('payment-recovery')
      } finally {
        setBusy(false)
      }
    },
    [authToken, startRun],
  )

  const pay = useCallback(async () => {
    if (!paidFlowReady || !gameConfig) {
      setError(paidBlockedReason)
      setScreen('attract')
      return
    }
    if (!wallet) {
      setError('Connect a wallet before paying the entry fee.')
      setScreen('connect')
      return
    }
    if (!authToken) {
      setError('Verify your wallet before paying the entry fee.')
      setScreen('verify')
      return
    }
    if (pendingPayment) {
      if (pendingPayment.player.toLowerCase() !== wallet.address.toLowerCase()) {
        setError(
          'A submitted payment is pending for another wallet. Reconnect that wallet before paying again.',
        )
        setScreen('review')
        return
      }
      if (pendingPayment.chainId !== wallet.chainId) {
        setError(
          'A submitted payment is pending on chain ' +
            pendingPayment.chainId +
            '. Switch to that chain before recovering it; do not pay again.',
        )
        setScreen('review')
        return
      }
      await recoverPayment(pendingPayment)
      return
    }
    setBusy(true)
    setError(null)
    setScreen('paying')
    try {
      const id = newPaymentId()
      const chain = chainFor(gameConfig.chainId)
      // Wallet state reads go through the CONNECTED wallet's provider (the
      // chain the user's wallet is actually on) — never a separate RPC client.
      const publicClient = createPublicClient({
        chain,
        transport: custom(wallet.provider),
      })
      const fee = BigInt(gameConfig.feeAmount)
      const allowance = await publicClient.readContract({
        address: gameConfig.frong as Address,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [wallet.address as Address, gameConfig.entry as Address],
      })
      if (allowance < fee) {
        setAnnounce('Approve the FRONG entry fee in your wallet.')
        const approvalHash = await wallet.client.writeContract({
          address: gameConfig.frong as Address,
          abi: ERC20_ABI,
          functionName: 'approve',
          account: wallet.address as Address,
          // Approve EXACTLY the current fee (payment-time live config),
          // never maxUint256.
          args: [gameConfig.entry as Address, fee],
        })
        setAnnounce('Waiting for the FRONG approval to confirm…')
        await publicClient.waitForTransactionReceipt({ hash: approvalHash })
      }
      setAnnounce('Confirm the FRONG entry fee in your wallet. It is non-refundable.')
      const hash = await wallet.client.writeContract({
        address: gameConfig.entry as Address,
        abi: ENTRY_ABI,
        functionName: 'play',
        account: wallet.address as Address,
        args: [id as Address],
      })
      const pending: PendingPayment = {
        paymentId: id,
        txHash: hash,
        chainId: gameConfig.chainId,
        player: wallet.address,
        createdAt: Date.now(),
      }
      savePendingPayment(pending)
      setPendingPayment(pending)
      setScreen('preparing')
      setAnnounce('Payment submitted. Validating on-chain…')
      await recoverPayment(pending)
    } catch (payError) {
      setError(
        'The wallet did not return a confirmed payment transaction. Check your wallet activity before trying again: ' +
          String(payError instanceof Error ? payError.message : payError),
      )
      setScreen('review')
    } finally {
      setBusy(false)
    }
  }, [
    authToken,
    gameConfig,
    paidBlockedReason,
    paidFlowReady,
    pendingPayment,
    recoverPayment,
    wallet,
  ])

  const finishRun = useCallback(
    (runResult: RunResult, inputLog: InputFrame[]) => {
      setResult(runResult)
      setScreen('results')
      setAnnounce('Run over. Submitting your run for verification…')
      void (async () => {
        if (!authToken || !session) return
        try {
          const logHash = await hashInputLog(inputLog)
          const submit = await api.submitRun(authToken, session.sessionId, inputLog, logHash)
          if (submit.status !== 200 || 'error' in submit.body) {
            const body = submit.body as { reason?: string }
            setRejectReason(body.reason ?? 'The server could not verify this run.')
            setScreen('rejected')
            setAnnounce('Verification failed.')
            return
          }
          setTokenId(submit.body.tokenId)
          // The durable server submission is now the source of truth. Clear
          // the local payment guard only after it has accepted this run, so a
          // crash during payment/session recovery cannot enable double pay.
          clearPendingPayment()
          setPendingPayment(null)
          setAnnounce('Run verified. Minting your trophy…')
          setScreen('minting')
        } catch {
          setRejectReason('The server could not be reached to verify this run.')
          setScreen('rejected')
        }
      })()
    },
    [authToken, session],
  )

  const privyConnect = useCallback(
    async (handle: PrivyHandle) => {
      setBusy(true)
      setError(null)
      try {
        if (!paidFlowReady || !gameConfig) {
          setError(paidBlockedReason)
          setScreen('attract')
          return
        }

        // The SDK metadata can lag the provider after a network change. Read
        // the provider's actual chain first, just like the injected-wallet
        // path, before deciding whether a switch is required.
        let walletHandle = await refreshChain(handle.wallet)
        if (walletHandle.chainId !== gameConfig.chainId) {
          const switched = await switchChain(walletHandle.provider, gameConfig.chainId)
          if (!switched) {
            setError(
              'Wrong network. Please switch your wallet to chain ' + gameConfig.chainId + '.',
            )
            return
          }
          walletHandle = await refreshChain(walletHandle)
        }
        if (walletHandle.chainId !== gameConfig.chainId) {
          setError('Wrong network. Please switch your wallet to chain ' + gameConfig.chainId + '.')
          return
        }

        const verify = await api.verifyPrivy(
          walletHandle.address,
          handle.accessToken,
          handle.idToken,
        )
        if (verify.status !== 200 || 'error' in verify.body) {
          setError('Privy verification failed. Please try again.')
          return
        }
        setWallet(walletHandle)
        setAuthToken(verify.body.authToken)
        setAnnounce('Wallet verified via Privy.')
        const hasRecoverablePayment =
          pendingPayment !== null &&
          pendingPayment.player.toLowerCase() === walletHandle.address.toLowerCase()
        if (hasRecoverablePayment && pendingPayment.chainId === walletHandle.chainId) {
          setScreen('payment-recovery')
        } else {
          setScreen('review')
        }
      } catch {
        setError(
          'Could not reach the game server to verify your wallet. Make sure the game server is running, then try again.',
        )
      } finally {
        setBusy(false)
      }
    },
    [gameConfig, paidBlockedReason, paidFlowReady, pendingPayment],
  )

  const quitRun = useCallback(() => {
    setPaused(false)
    setSession(null)
    setResult(null)
    setTokenId(null)
    setMint(null)
    setRejectReason(null)
    setAnnounce('Back to the start.')
    setScreen('attract')
  }, [])

  const resumeRun = useCallback(() => {
    setPaused(false)
    headingRef.current?.focus()
  }, [])

  const hudTierIndex = tierForScore(hud.score)
  const hudTier = TIERS[hudTierIndex]
  const hudNextTier = TIERS[hudTierIndex + 1] ?? null
  const tierProgress = hudNextTier ? (hud.score - hudTier.min) / (hudNextTier.min - hudTier.min) : 1
  const progressPct = Math.round(Math.min(1, Math.max(0, tierProgress)) * 100)

  const feeText = gameConfig ? formatEther(BigInt(gameConfig.feeAmount)) + ' FRONG' : '…'
  const pendingForWallet =
    pendingPayment !== null &&
    wallet !== null &&
    pendingPayment.player.toLowerCase() === wallet.address.toLowerCase()
  const pendingOnWalletChain = pendingForWallet && pendingPayment.chainId === wallet?.chainId

  const configNotice =
    configStatus === 'loading' ? (
      <p className={arcade.help} role="status" aria-busy="true">
        Checking game server configuration…
      </p>
    ) : configStatus === 'error' ? (
      <div className={arcade.errorBox} role="alert">
        {ALERT_ICON}
        <span>{configError ?? 'Game server unavailable. Paid runs are disabled.'}</span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => void loadGameConfig()}
        >
          Try again
        </button>
      </div>
    ) : null

  const timeStatClass =
    hud.timeLeft <= 5
      ? arcade.hudStatDanger
      : hud.timeLeft <= 10
        ? arcade.hudStatWarn
        : arcade.hudStat

  const heading = (node: HTMLElement | null) => {
    headingRef.current = node
  }

  return (
    <PrivyLoginProvider>
      <div className={embedded ? styles.embedded : styles.page}>
        <div role="status" className="visually-hidden">
          {announce}
        </div>

        {!embedded && (
          <header className={styles.header}>
            <span className={styles.brand}>
              <img className={styles.brandMark} src="/assets/avatar.png" alt="" />
              FRONG Catch
            </span>
            <a className={styles.backLink} href="/#play">
              Free practice on the fan page
            </a>
          </header>
        )}

        <div className={arcade.shell}>
          {screen === 'poster' && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <p className={arcade.badge}>Paid beta · testnet first</p>
              <h1 className={arcade.title}>
                FRONG <span className={arcade.accent}>Catch</span>
              </h1>
              <p className={arcade.lede}>
                Pay a FRONG entry fee, play one verified run, and earn an ERC-721 trophy minted
                straight to your wallet. Practice stays free on the fan page.
              </p>
              {configNotice}
              {configStatus === 'ready' && buildMismatch && (
                <p className={arcade.errorBox} role="alert">
                  {ALERT_ICON}
                  <span>
                    This build does not match the game server&apos;s verified simulation. Paid runs
                    are disabled.
                  </span>
                </p>
              )}
              <div className={arcade.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!paidFlowReady}
                  onClick={() => setScreen('attract')}
                >
                  Play
                </button>
                <a className="btn btn-secondary" href="/#play">
                  Practice on the fan page
                </a>
              </div>
            </div>
          )}

          {screen === 'attract' && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <h2 className={arcade.title}>One run. One trophy.</h2>
              <p className={arcade.lede}>
                One minute, forty-five flies. The rarer the fly, the more points. Your run is
                replay-verified by the game server before any trophy is minted.
              </p>
              <ul className={arcade.legend} aria-label="Fly types and points">
                {FLY_TYPE_IDS.map((id) => (
                  <li key={id} className={arcade.legendItem}>
                    <FlyGlyph type={id} />
                    <span className={arcade.legendName}>{FLY_LABELS[id]}</span>
                    <span className={arcade.legendNote}>{FLY_NOTES[id]}</span>
                  </li>
                ))}
              </ul>
              <ul className={arcade.tiers} aria-label="Score tiers">
                {TIERS.map((tier) => (
                  <li key={tier.name} className={arcade.tierItem}>
                    <span className={arcade.tierName}>{tier.name}</span>
                    <span className={arcade.tierMin}>
                      {tier.min === 0 ? 'any score' : tier.min + '+'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={arcade.help}>
                Every run is replay-verified against the server&apos;s simulation build. Automated
                solver-style inputs are rejected.
              </p>
              {best > 0 && (
                <p className={arcade.help}>
                  Your practice best: <strong>{best}</strong>
                </p>
              )}
              {configNotice}
              {configStatus === 'ready' && buildMismatch && (
                <p className={arcade.errorBox} role="alert">
                  {ALERT_ICON}
                  <span>
                    This build does not match the game server&apos;s verified simulation. Paid runs
                    are disabled.
                  </span>
                </p>
              )}
              <div className={arcade.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!paidFlowReady}
                  onClick={() => setScreen('connect')}
                >
                  Play
                </button>
                {embedded && onPractice && (
                  <button type="button" className="btn btn-secondary" onClick={onPractice}>
                    Free practice
                  </button>
                )}
                {embedded && onExit && (
                  <button type="button" className="btn btn-ghost" onClick={onExit}>
                    Back
                  </button>
                )}
              </div>
            </div>
          )}

          {screen === 'connect' && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <h2 className={arcade.title}>Connect your wallet</h2>
              <p className={arcade.lede}>
                The game asks for nothing but your wallet and one signature to prove you own it.
                Private keys never leave your wallet.
              </p>
              <div className={arcade.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void connect('injected')}
                >
                  Connect injected wallet
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !WC_PROJECT_ID}
                  onClick={() => void connect('wc')}
                >
                  Connect with WalletConnect
                </button>
                <PrivyConnectControl
                  busy={busy}
                  onConnect={(handle) => void privyConnect(handle)}
                  onError={(message) => setError(message)}
                  buttonClass="btn btn-secondary"
                  helpClass={arcade.help}
                />
              </div>
              {!WC_PROJECT_ID && (
                <p className={arcade.help}>
                  WalletConnect needs a project id to be configured for this deployment.
                </p>
              )}
              {error && (
                <p className={arcade.errorBox} role="alert">
                  {ALERT_ICON}
                  <span>{error}</span>
                </p>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => setScreen('attract')}>
                Back
              </button>
            </div>
          )}

          {screen === 'verify' && wallet && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <h2 className={arcade.title}>Verify your wallet</h2>
              <p className={arcade.lede}>
                Sign a one-time message to prove you control {wallet.address}. This signature cannot
                move funds — it only binds your wallet to this session.
              </p>
              <div className={arcade.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void signVerify()}
                >
                  Sign to verify
                </button>
              </div>
              {error && (
                <p className={arcade.errorBox} role="alert">
                  {ALERT_ICON}
                  <span>{error}</span>
                </p>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => setScreen('connect')}>
                Back
              </button>
            </div>
          )}

          {screen === 'review' && wallet && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <h2 className={arcade.title}>Entry review</h2>
              <p className={arcade.lede}>
                One run costs <strong className={styles.fee}>{feeText}</strong>, paid from{' '}
                {wallet.address.slice(0, 10)}….
              </p>
              <p className={arcade.warningBox}>
                {WARN_ICON}
                <span>
                  The entry fee is non-refundable. A submitted payment stays recoverable until the
                  server accepts its one run. If you leave or lose connection, recover that payment
                  instead of paying again. One payment = one run = one trophy.
                </span>
              </p>
              {pendingPayment ? (
                <div className={arcade.actions}>
                  {pendingForWallet && pendingOnWalletChain ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => {
                        if (pendingPayment) void recoverPayment(pendingPayment)
                      }}
                    >
                      Recover submitted payment
                    </button>
                  ) : (
                    <p className={arcade.help} role="status">
                      {pendingForWallet
                        ? 'A submitted payment is on chain ' +
                          pendingPayment.chainId +
                          '. Switch to that chain to recover it; do not pay again.'
                        : 'A submitted payment is pending for another wallet. Reconnect that wallet before paying again.'}
                    </p>
                  )}
                </div>
              ) : (
                <div className={arcade.actions}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void pay()}
                  >
                    Pay {feeText} and play
                  </button>
                </div>
              )}
              {error && (
                <p className={arcade.errorBox} role="alert">
                  {ALERT_ICON}
                  <span>{error}</span>
                </p>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => setScreen('connect')}>
                Back
              </button>
            </div>
          )}

          {screen === 'paying' && (
            <div
              className={arcade.center + ' ' + arcade.screenIn}
              ref={heading}
              tabIndex={-1}
              aria-busy="true"
            >
              <h2 className={arcade.title}>Confirm in your wallet</h2>
              <Spinner />
              <p className={arcade.lede}>
                Approve and pay the FRONG entry fee when your wallet asks.
              </p>
            </div>
          )}

          {screen === 'preparing' && (
            <div
              className={arcade.center + ' ' + arcade.screenIn}
              ref={heading}
              tabIndex={-1}
              aria-busy="true"
            >
              <h2 className={arcade.title}>Validating payment</h2>
              <Spinner label="Validating payment…" />
              <p className={arcade.lede}>
                The server is checking your payment on-chain. One moment…
              </p>
            </div>
          )}

          {screen === 'payment-recovery' && pendingPayment && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <h2 className={arcade.title}>Payment recovery</h2>
              <p className={arcade.errorBox} role="alert">
                {ALERT_ICON}
                <span>
                  {prepareError ??
                    'A payment was already submitted. Recover it before creating another payment.'}
                </span>
              </p>
              <p className={arcade.help}>
                Transaction: <code>{pendingPayment.txHash}</code>
              </p>
              {gameConfig && explorerUrlFor(gameConfig.chainId) && (
                <p className={arcade.help}>
                  <a
                    href={explorerUrlFor(gameConfig.chainId) + '/tx/' + pendingPayment.txHash}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    View transaction on the explorer
                  </a>
                </p>
              )}
              <div className={arcade.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void recoverPayment(pendingPayment)}
                >
                  Retry recovery
                </button>
                <button type="button" className="btn btn-ghost" onClick={quitRun}>
                  Back to start
                </button>
              </div>
            </div>
          )}

          {screen === 'payment-failed' && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <h2 className={arcade.title}>Payment not accepted</h2>
              <p className={arcade.errorBox} role="alert">
                {ALERT_ICON}
                <span>
                  {prepareError ??
                    'The payment could not be validated on-chain. Check the transaction before attempting another payment.'}
                </span>
              </p>
              <div className={arcade.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setScreen('review')}
                >
                  Try again
                </button>
                <button type="button" className="btn btn-ghost" onClick={quitRun}>
                  Back to start
                </button>
              </div>
            </div>
          )}

          {screen === 'run' && (
            <div
              className={arcade.run + ' ' + arcade.screenIn}
              ref={heading}
              tabIndex={-1}
              aria-label="Game run"
            >
              <div className={arcade.hud}>
                <div className={arcade.hudStats}>
                  <span className={arcade.hudStat}>
                    Score{' '}
                    <strong
                      key={hud.score}
                      className={arcade.hudStrong + ' ' + arcade.hudStrongPop}
                    >
                      {hud.score}
                    </strong>
                  </span>
                  <span className={arcade.hudStat}>
                    Flies <strong className={arcade.hudStrong}>{hud.caught}/45</strong>
                  </span>
                  <span className={timeStatClass}>
                    Time <strong className={arcade.hudStrong}>{hud.timeLeft}s</strong>
                  </span>
                </div>
                <button
                  type="button"
                  className={arcade.hudPause}
                  aria-label="Pause game"
                  onClick={() => setPaused(true)}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="2.5" y="2" width="4" height="12" rx="1" fill="currentColor" />
                    <rect x="9.5" y="2" width="4" height="12" rx="1" fill="currentColor" />
                  </svg>
                </button>
              </div>
              <div className={arcade.progress} aria-hidden="true">
                <div className={arcade.progressTrack}>
                  <div className={arcade.progressFill} style={{ width: progressPct + '%' }} />
                </div>
                <div className={arcade.progressMeta}>
                  <span
                    key={hudTier.name}
                    className={arcade.progressTier + ' ' + arcade.progressTierPop}
                  >
                    {hudTier.name}
                  </span>
                  <span className={arcade.progressNext}>
                    {hudNextTier
                      ? 'Next: ' + hudNextTier.name + ' at ' + hudNextTier.min
                      : 'Perfect run'}
                  </span>
                </div>
              </div>
              <span className="visually-hidden">Current tier: {hudTier.name}</span>
              <div className={arcade.stageWrap}>
                <CanvasStage
                  key={runId}
                  seed={seed}
                  durationTicks={session?.durationTicks}
                  countdownTicks={session?.countdownTicks}
                  paused={paused}
                  reducedMotion={reducedMotion}
                  className={arcade.stageInner}
                  onHud={setHud}
                  onFinish={finishRun}
                />
                {hud.phase === 'countdown' && !paused && (
                  <div className={arcade.overlay} aria-hidden="true">
                    <span className={arcade.getReady}>Get ready</span>
                    <span
                      key={Math.ceil(hud.countdownLeft / TICKS_PER_SECOND)}
                      className={arcade.countdown}
                    >
                      {Math.ceil(hud.countdownLeft / TICKS_PER_SECOND)}
                    </span>
                  </div>
                )}
                {paused && (
                  <div
                    className={arcade.overlay}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Pause menu"
                  >
                    <div className={arcade.pauseCard} ref={pauseCardRef}>
                      <p className={arcade.pauseTitle}>Paused</p>
                      <p className={arcade.help}>
                        Leaving ends this local run. Your submitted payment remains recoverable
                        until the server accepts one run.
                      </p>
                      <div className={arcade.actions}>
                        <button type="button" className="btn btn-primary" onClick={resumeRun}>
                          Resume
                        </button>
                        <button type="button" className="btn btn-danger" onClick={quitRun}>
                          Leave run
                        </button>
                      </div>
                      <p className={arcade.pauseHint}>
                        <kbd className="kbd">P</kbd> or <kbd className="kbd">Esc</kbd> to resume
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {screen === 'results' && result && (
            <div
              className={arcade.center + ' ' + arcade.screenIn}
              ref={heading}
              tabIndex={-1}
              aria-busy="true"
            >
              <h2 className={arcade.title}>Run over</h2>
              <dl className={arcade.stats}>
                <div className={arcade.stat}>
                  <dt>Score</dt>
                  <dd className={arcade.statValue}>
                    {result.score}
                    <span className={arcade.statUnit}>/109</span>
                  </dd>
                </div>
                <div className={arcade.stat}>
                  <dt>Flies</dt>
                  <dd className={arcade.statValue}>
                    {result.caught}
                    <span className={arcade.statUnit}>/45</span>
                  </dd>
                </div>
              </dl>
              <Spinner label="Submitting for server replay verification…" />
            </div>
          )}

          {screen === 'minting' && mint === null && (
            <div
              className={arcade.center + ' ' + arcade.screenIn}
              ref={heading}
              tabIndex={-1}
              aria-busy="true"
            >
              <h2 className={arcade.title}>Minting your trophy</h2>
              <Spinner />
              <p className={arcade.lede}>
                Run verified. The trophy is being minted to your wallet — no gas on you.
              </p>
            </div>
          )}

          {screen === 'minted' && mint && result && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <p className={arcade.badge}>Trophy minted</p>
              <h2 className={arcade.title}>{mint.tierName}</h2>
              {TIER_FLAVOR[mint.tierName] && (
                <p className={arcade.flavor}>{TIER_FLAVOR[mint.tierName]}</p>
              )}
              <dl className={arcade.stats}>
                <div className={arcade.stat}>
                  <dt>Score</dt>
                  <dd className={arcade.statValue}>
                    {mint.score}
                    <span className={arcade.statUnit}>/109</span>
                  </dd>
                </div>
                <div className={arcade.stat}>
                  <dt>Flies</dt>
                  <dd className={arcade.statValue}>
                    {mint.fliesCaught}
                    <span className={arcade.statUnit}>/45</span>
                  </dd>
                </div>
                <div className={arcade.stat}>
                  <dt>Trophy</dt>
                  <dd className={arcade.statValue}>#{mint.tokenId}</dd>
                </div>
              </dl>
              <p className={arcade.help}>In your wallet at {wallet?.address ?? ''}</p>
              {mint.txHash && (
                <p className={arcade.help}>
                  Mint transaction: <code>{mint.txHash.slice(0, 14)}…</code>
                </p>
              )}
              {wallet && mint.txHash && explorerUrlFor(wallet.chainId) && (
                <a
                  className="btn btn-secondary"
                  href={explorerUrlFor(wallet.chainId) + '/tx/' + mint.txHash}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on explorer
                </a>
              )}
              <div className={arcade.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setScreen('review')}
                >
                  Play again
                </button>
                <button type="button" className="btn btn-ghost" onClick={quitRun}>
                  Back to start
                </button>
              </div>
            </div>
          )}

          {screen === 'rejected' && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <h2 className={arcade.title}>Run not accepted</h2>
              <p className={arcade.lede}>
                The server could not verify this run and no trophy was minted. If you believe this
                is an error, contact support with your session details.
              </p>
              {rejectReason && (
                <p className={arcade.errorBox} role="alert">
                  {ALERT_ICON}
                  <span>{rejectReason}</span>
                </p>
              )}
              <button type="button" className="btn btn-ghost" onClick={quitRun}>
                Back to start
              </button>
            </div>
          )}

          {screen === 'delayed' && mint && (
            <div className={arcade.center + ' ' + arcade.screenIn} ref={heading} tabIndex={-1}>
              <h2 className={arcade.title}>Mint delayed</h2>
              <p className={arcade.lede}>
                Your run is verified. The mint is queued and your trophy will arrive in your wallet
                shortly — nothing else to do.
              </p>
              <div className={arcade.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setScreen('minting')}
                >
                  Check again
                </button>
                <button type="button" className="btn btn-ghost" onClick={quitRun}>
                  Back to start
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </PrivyLoginProvider>
  )
}
