import { useCallback, useEffect, useRef, useState } from 'react'
import { createPublicClient, custom, formatEther, parseAbi } from 'viem'
import type { Address } from 'viem'
import { CanvasStage } from '../game/CanvasStage'
import type { HudSnapshot, InputFrame, RunResult } from '../game/CanvasStage'
import { TICKS_PER_SECOND, TIERS, tierForScore } from '../game/sim/constants'
import { loadBestScore } from '../game/util'
import { usePrefersReducedMotion } from '../game/usePrefersReducedMotion'
import { WC_PROJECT_ID, explorerUrlFor } from './config'
import { PrivyConnectControl, PrivyLoginProvider } from './privy'
import type { PrivyHandle } from './usePrivyLogin'
import { hashInputLog, newPaymentId } from './log'
import * as api from './api'
import type { GameConfigResponse, MintStatusResponse, SessionResponse } from './api'
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
  | 'payment-failed'
  | 'run'
  | 'results'
  | 'minting'
  | 'minted'
  | 'rejected'
  | 'delayed'

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const ENTRY_ABI = parseAbi(['function play(bytes32 paymentId)'])

const POLL_MS = 1_200

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
  const [serverError, setServerError] = useState(false)
  const [buildMismatch, setBuildMismatch] = useState(false)
  const [wallet, setWallet] = useState<WalletHandle | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)
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
  const prevScreenRef = useRef<Screen>(embedded ? 'attract' : 'poster')
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    let cancelled = false
    api
      .fetchGameConfig()
      .then((config) => {
        if (!cancelled) {
          setGameConfig(config)
          setBuildMismatch(config.buildHash !== import.meta.env.VITE_SIM_BUILD_HASH)
        }
      })
      .catch(() => {
        if (!cancelled) setServerError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Focus the new screen's heading on every transition.
  useEffect(() => {
    if (screen !== prevScreenRef.current) {
      headingRef.current?.focus()
      prevScreenRef.current = screen
    }
  }, [screen])

  // Poll mint status while minting/delayed-check.
  useEffect(() => {
    if ((screen !== 'minting' && screen !== 'delayed') || tokenId === null) {
      return
    }
    let cancelled = false
    const poll = () => {
      api
        .fetchMintStatus(tokenId)
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
  }, [screen, tokenId])

  const connect = useCallback(
    async (kind: 'injected' | 'wc') => {
      setBusy(true)
      setError(null)
      try {
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
      } finally {
        setBusy(false)
      }
    },
    [gameConfig],
  )

  const signVerify = useCallback(async () => {
    if (!wallet) return
    setBusy(true)
    setError(null)
    try {
      const challenge = await api.fetchChallenge(wallet.address)
      if (challenge.status !== 200) {
        setError('Could not start verification. Is the server reachable?')
        return
      }
      const signature = await wallet.client.signMessage({
        account: wallet.address as Address,
        message: challenge.body.message,
      })
      const verify = await api.verifyWallet(wallet.address, challenge.body.nonce, signature)
      if (verify.status !== 200) {
        setError('Signature verification failed. Try again.')
        return
      }
      setAuthToken(verify.body.authToken)
      setAnnounce('Wallet verified.')
      setScreen('review')
    } finally {
      setBusy(false)
    }
  }, [wallet])

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

  const pay = useCallback(async () => {
    if (!wallet || !gameConfig || !authToken) return
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
        await wallet.client.writeContract({
          address: gameConfig.frong as Address,
          abi: ERC20_ABI,
          functionName: 'approve',
          account: wallet.address as Address,
          // Approve EXACTLY the current fee (payment-time live config),
          // never maxUint256.
          args: [gameConfig.entry as Address, fee],
        })
      }
      setAnnounce('Confirm the FRONG entry fee in your wallet. It is non-refundable.')
      const hash = await wallet.client.writeContract({
        address: gameConfig.entry as Address,
        abi: ENTRY_ABI,
        functionName: 'play',
        account: wallet.address as Address,
        args: [id as Address],
      })
      setScreen('preparing')
      setAnnounce('Payment submitted. Validating on-chain…')

      // The server requires confirmations; retry briefly while the block
      // finalizes (spec W6: optimistic, brief).
      let sessionResponse: Awaited<ReturnType<typeof api.requestSession>> | null = null
      for (let attempt = 0; attempt < 10; attempt += 1) {
        sessionResponse = await api.requestSession(authToken, hash, id)
        if (sessionResponse.status === 200 || !('error' in sessionResponse.body)) break
        const reason = (sessionResponse.body as { reason?: string }).reason
        if (reason !== 'transaction not final yet') break
        await new Promise((resolve) => setTimeout(resolve, 1_500))
      }
      if (sessionResponse === null) {
        setPrepareError('Payment validation failed.')
        setScreen('payment-failed')
        return
      }
      if (sessionResponse.status !== 200 || 'error' in sessionResponse.body) {
        const body = sessionResponse.body as { error?: string; reason?: string }
        setPrepareError(body.reason ?? body.error ?? 'Payment validation failed.')
        setScreen('payment-failed')
        return
      }
      setSession(sessionResponse.body as SessionResponse)
      setSeed((sessionResponse.body as SessionResponse).seed)
      setRunId((n) => n + 1)
      setHud({
        phase: 'countdown',
        countdownLeft: (sessionResponse.body as SessionResponse).countdownTicks,
        score: 0,
        caught: 0,
        timeLeft: Math.ceil(
          (sessionResponse.body as SessionResponse).durationTicks / TICKS_PER_SECOND,
        ),
      })
      setAnnounce('Run started. Move the lily pad and catch as many flies as you can.')
      setScreen('run')
    } catch (payError) {
      setError(
        'Payment did not go through: ' +
          String(payError instanceof Error ? payError.message : payError),
      )
      setScreen('review')
    } finally {
      setBusy(false)
    }
  }, [wallet, gameConfig, authToken])

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

  const privyConnect = useCallback(async (handle: PrivyHandle) => {
    setBusy(true)
    setError(null)
    try {
      const verify = await api.verifyPrivy(
        handle.wallet.address,
        handle.accessToken,
        handle.idToken,
      )
      if (verify.status !== 200 || 'error' in verify.body) {
        setError('Privy verification failed. Please try again.')
        return
      }
      setWallet(handle.wallet)
      setAuthToken(verify.body.authToken)
      setAnnounce('Wallet verified via Privy.')
      setScreen('review')
    } catch {
      setError(
        'Could not reach the game server to verify your wallet. Make sure the game server is running, then try again.',
      )
    } finally {
      setBusy(false)
    }
  }, [])

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

  const hudTierIndex = tierForScore(hud.score)
  const hudTier = TIERS[hudTierIndex]
  const hudNextTier = TIERS[hudTierIndex + 1] ?? null
  const tierProgress = hudNextTier ? (hud.score - hudTier.min) / (hudNextTier.min - hudTier.min) : 1
  const progressPct = Math.round(Math.min(1, Math.max(0, tierProgress)) * 100)

  const feeText = gameConfig ? formatEther(BigInt(gameConfig.feeAmount)) + ' FRONG' : '…'

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

        <div className={styles.panel}>
          {screen === 'poster' && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <p className={styles.badge}>Paid beta · testnet first</p>
              <h1 className={styles.title}>
                FRONG <span className={styles.accent}>Catch</span>
              </h1>
              <p className={styles.lede}>
                Pay a FRONG entry fee, play one verified run, and earn an ERC-721 trophy minted
                straight to your wallet. Practice stays free on the fan page.
              </p>
              {buildMismatch && (
                <p className={styles.errorText}>
                  This build does not match the game server's verified simulation. Paid runs are
                  disabled.
                </p>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={buildMismatch}
                  onClick={() => setScreen('attract')}
                >
                  Play
                </button>
                <a className={styles.buttonSecondary} href="/#play">
                  Practice on the fan page
                </a>
              </div>
              {serverError && (
                <p className={styles.errorText}>Game server unreachable — try again later.</p>
              )}
            </div>
          )}

          {screen === 'attract' && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>One run. One trophy.</h2>
              <p className={styles.lede}>
                One minute, forty-five flies. The rarer the fly, the more points. Your run is
                replay-verified by the game server before any trophy is minted.
              </p>
              <ul className={styles.tiers} aria-label="Score tiers">
                {TIERS.map((tier) => (
                  <li key={tier.name} className={styles.tierItem}>
                    <span className={styles.tierName}>{tier.name}</span>
                    <span className={styles.tierMin}>
                      {tier.min === 0 ? 'any score' : tier.min + '+'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={styles.help}>
                Every run is replay-verified against the server's simulation build. Automated
                solver-style inputs are rejected.
              </p>
              {best > 0 && (
                <p className={styles.help}>
                  Your practice best: <strong>{best}</strong>
                </p>
              )}
              {buildMismatch && (
                <p className={styles.errorText}>
                  This build does not match the game server's verified simulation. Paid runs are
                  disabled.
                </p>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={buildMismatch}
                  onClick={() => setScreen('connect')}
                >
                  Play
                </button>
                {embedded && onPractice && (
                  <button type="button" className={styles.buttonSecondary} onClick={onPractice}>
                    Free practice
                  </button>
                )}
                {embedded && onExit && (
                  <button type="button" className={styles.buttonGhost} onClick={onExit}>
                    Back
                  </button>
                )}
              </div>
            </div>
          )}

          {screen === 'connect' && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Connect your wallet</h2>
              <p className={styles.lede}>
                The game asks for nothing but your wallet and one signature to prove you own it.
                Private keys never leave your wallet.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy}
                  onClick={() => void connect('injected')}
                >
                  Connect injected wallet
                </button>
                <button
                  type="button"
                  className={styles.buttonSecondary}
                  disabled={busy || !WC_PROJECT_ID}
                  onClick={() => void connect('wc')}
                >
                  Connect with WalletConnect
                </button>
                <PrivyConnectControl
                  busy={busy}
                  onConnect={(handle) => void privyConnect(handle)}
                  onError={(message) => setError(message)}
                  buttonClass={styles.buttonSecondary}
                  helpClass={styles.help}
                />
              </div>
              {!WC_PROJECT_ID && (
                <p className={styles.help}>
                  WalletConnect needs a project id to be configured for this deployment.
                </p>
              )}
              {error && <p className={styles.errorText}>{error}</p>}
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() => setScreen('attract')}
              >
                Back
              </button>
            </div>
          )}

          {screen === 'verify' && wallet && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Verify your wallet</h2>
              <p className={styles.lede}>
                Sign a one-time message to prove you control {wallet.address}. This signature cannot
                move funds — it only binds your wallet to this session.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy}
                  onClick={() => void signVerify()}
                >
                  Sign to verify
                </button>
              </div>
              {error && <p className={styles.errorText}>{error}</p>}
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() => setScreen('connect')}
              >
                Back
              </button>
            </div>
          )}

          {screen === 'review' && wallet && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Entry review</h2>
              <p className={styles.lede}>
                One run costs <strong className={styles.fee}>{feeText}</strong>, paid from{' '}
                {wallet.address.slice(0, 10)}….
              </p>
              <p className={styles.warning}>
                The entry fee is non-refundable. Quitting or disconnecting mid-run forfeits the
                entry. One payment = one run = one trophy.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy}
                  onClick={() => void pay()}
                >
                  Pay {feeText} and play
                </button>
              </div>
              {error && <p className={styles.errorText}>{error}</p>}
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={() => setScreen('connect')}
              >
                Back
              </button>
            </div>
          )}

          {screen === 'paying' && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Confirm in your wallet</h2>
              <p className={styles.lede}>
                Approve and pay the FRONG entry fee when your wallet asks.
              </p>
            </div>
          )}

          {screen === 'preparing' && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Validating payment</h2>
              <p className={styles.lede}>
                The server is checking your payment on-chain. One moment…
              </p>
            </div>
          )}

          {screen === 'payment-failed' && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Payment not accepted</h2>
              <p className={styles.errorText}>
                {prepareError ??
                  'The payment could not be validated on-chain. You were not charged.'}
              </p>
              <div className={styles.actions}>
                <button type="button" className={styles.button} onClick={() => setScreen('review')}>
                  Try again
                </button>
                <button type="button" className={styles.buttonGhost} onClick={quitRun}>
                  Back to start
                </button>
              </div>
            </div>
          )}

          {screen === 'run' && (
            <div className={styles.run} ref={heading} tabIndex={-1} aria-label="Game run">
              <div className={styles.hud}>
                <span>
                  Score <strong>{hud.score}</strong>
                </span>
                <span>
                  Flies <strong>{hud.caught}/45</strong>
                </span>
                <span>
                  Time <strong>{hud.timeLeft}s</strong>
                </span>
              </div>
              <div className={styles.progress} aria-hidden="true">
                <div className={styles.progressTrack}>
                  <div className={styles.progressFill} style={{ width: progressPct + '%' }} />
                </div>
                <div className={styles.progressMeta}>
                  <span>{hudTier.name}</span>
                  <span>
                    {hudNextTier
                      ? 'Next: ' + hudNextTier.name + ' at ' + hudNextTier.min
                      : 'Perfect run'}
                  </span>
                </div>
              </div>
              <span className="visually-hidden">Current tier: {hudTier.name}</span>
              <div className={styles.stageWrap}>
                <CanvasStage
                  key={runId}
                  seed={seed}
                  durationTicks={session?.durationTicks}
                  countdownTicks={session?.countdownTicks}
                  paused={paused}
                  reducedMotion={reducedMotion}
                  className={styles.stageInner}
                  onHud={setHud}
                  onFinish={finishRun}
                />
                {hud.phase === 'countdown' && !paused && (
                  <div className={styles.overlay} aria-hidden="true">
                    <span className={styles.getReady}>Get ready</span>
                    <span className={styles.countdown}>
                      {Math.ceil(hud.countdownLeft / TICKS_PER_SECOND)}
                    </span>
                  </div>
                )}
                {paused && (
                  <div className={styles.overlay}>
                    <p className={styles.pauseTitle}>Paused</p>
                    <p className={styles.help}>
                      Quitting now forfeits this run — your entry is consumed.
                    </p>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.button}
                        onClick={() => setPaused(false)}
                      >
                        Resume
                      </button>
                      <button type="button" className={styles.buttonGhost} onClick={quitRun}>
                        Quit (forfeits entry)
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {screen === 'results' && result && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Run over</h2>
              <dl className={styles.stats}>
                <div>
                  <dt>Score</dt>
                  <dd>
                    {result.score}
                    <span>/109</span>
                  </dd>
                </div>
                <div>
                  <dt>Flies</dt>
                  <dd>
                    {result.caught}
                    <span>/45</span>
                  </dd>
                </div>
              </dl>
              <p className={styles.lede}>Submitting for server replay verification…</p>
            </div>
          )}

          {screen === 'minting' && mint === null && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Minting your trophy</h2>
              <p className={styles.lede}>
                Run verified. The trophy is being minted to your wallet — no gas on you.
              </p>
            </div>
          )}

          {screen === 'minted' && mint && result && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <p className={styles.badge}>Trophy minted</p>
              <h2 className={styles.title}>{mint.tierName}</h2>
              <dl className={styles.stats}>
                <div>
                  <dt>Score</dt>
                  <dd>
                    {mint.score}
                    <span>/109</span>
                  </dd>
                </div>
                <div>
                  <dt>Flies</dt>
                  <dd>
                    {mint.fliesCaught}
                    <span>/45</span>
                  </dd>
                </div>
                <div>
                  <dt>Trophy</dt>
                  <dd>#{mint.tokenId}</dd>
                </div>
              </dl>
              <p className={styles.help}>In your wallet at {wallet?.address ?? ''}</p>
              {mint.txHash && (
                <p className={styles.help}>
                  Mint transaction: <code>{mint.txHash.slice(0, 14)}…</code>
                </p>
              )}
              {wallet && mint.txHash && explorerUrlFor(wallet.chainId) && (
                <a
                  className={styles.buttonSecondary}
                  href={explorerUrlFor(wallet.chainId) + '/tx/' + mint.txHash}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on explorer
                </a>
              )}
              <div className={styles.actions}>
                <button type="button" className={styles.button} onClick={() => setScreen('review')}>
                  Play again
                </button>
                <button type="button" className={styles.buttonGhost} onClick={quitRun}>
                  Back to start
                </button>
              </div>
            </div>
          )}

          {screen === 'rejected' && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Run not accepted</h2>
              <p className={styles.lede}>
                The server could not verify this run and no trophy was minted. If you believe this
                is an error, contact support with your session details.
              </p>
              {rejectReason && <p className={styles.help}>{rejectReason}</p>}
              <button type="button" className={styles.buttonGhost} onClick={quitRun}>
                Back to start
              </button>
            </div>
          )}

          {screen === 'delayed' && mint && (
            <div className={styles.center} ref={heading} tabIndex={-1}>
              <h2 className={styles.title}>Mint delayed</h2>
              <p className={styles.lede}>
                Your run is verified. The mint is queued and your trophy will arrive in your wallet
                shortly — nothing else to do.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => setScreen('minting')}
                >
                  Check again
                </button>
                <button type="button" className={styles.buttonGhost} onClick={quitRun}>
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
