import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { createApp } from '../src/http'
import { computeSimBuildHash } from '../src/simBuildHash'
import { Store } from '../src/store'
import { MintWorker } from '../src/mintQueue'
import { hashInputLog } from '../src/verify'
import type { ServerConfig } from '../src/config'
import { createGame, stepGame, autoInput } from '../../../src/game/sim/sim'
import type { InputFrame } from '../../../src/game/sim/types'

const DEPLOYMENT_FILE = join(
  __dirname,
  '..',
  '..',
  '..',
  'contracts',
  'deployments',
  'localhost.json',
)
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
// Well-known Hardhat dev accounts: #1 minter, #2 player. Local EVM only.
const MINTER_KEY =
  process.env.MINTER_KEY ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const PLAYER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

const FRONG_ABI = parseAbi([
  'function drip()',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const ENTRY_ABI = parseAbi(['function play(bytes32 paymentId)'])
const TROPHY_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function attestationOf(uint256 tokenId) view returns (uint8 tier, uint16 score, uint8 fliesCaught, bytes32 seedCommitment, bytes32 inputLogHash, uint256 timestamp, bytes32 buildHash)',
])

async function chainUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { result?: string }
    return body.result === '0x7a69'
  } catch {
    return false
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function setup() {
  if (!(await chainUp()) || !existsSync(DEPLOYMENT_FILE)) {
    console.warn('[integration] SKIPPED: no local chain at ' + RPC + ' or no local deployment')
    return null
  }
  const chain = defineChain({
    id: 31337,
    name: 'Local Hardhat',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })
  const publicClient = createPublicClient({ chain, transport: http(RPC) })
  const player = privateKeyToAccount(PLAYER_KEY)
  const playerWallet = createWalletClient({ chain, transport: http(RPC), account: player })

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8')) as {
    frong: string
    entry: string
    trophy: string
    price: string
  }
  const dataDir = join(tmpdir(), 'frong-e2e-' + randomBytes(8).toString('hex'))
  const config: ServerConfig = {
    port: 0,
    rpcUrl: RPC,
    chainId: 31337,
    frong: deployment.frong,
    entry: deployment.entry,
    trophy: deployment.trophy,
    minterKey: MINTER_KEY,
    feeAmount: BigInt(deployment.price),
    sessionTtlMs: 10 * 60 * 1000,
    authTtlMs: 30 * 60 * 1000,
    confirmations: 1,
    countdownTicks: 180,
    durationTicks: 3600,
    metadataBaseUrl: 'http://127.0.0.1:8787',
    dataDir,
    privyAppId: null,
    privyAppSecret: null,
    privyVerificationKey: null,
    corsOrigins: [],
    rateLimitPerMinute: 30,
    rateLimitBurst: 60,
    challengeRatePerMinute: 10,
    pinataJwt: null,
    pinataGateway: null,
    kmsRegion: null,
    kmsKeyId: null,
    kmsMinerAddress: null,
  }
  const store = new Store(dataDir)
  const buildHash = computeSimBuildHash()
  const server = createApp({ config, store, buildHash })
  const worker = new MintWorker(config, store)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = address && typeof address === 'object' ? 'http://127.0.0.1:' + address.port : ''
  worker.start()
  return {
    base,
    config,
    buildHash,
    publicClient,
    player,
    playerWallet,
    stop: async () => {
      worker.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/**
 * REAL end-to-end on a real local EVM (Hardhat node): faucet, approve, paid
 * entry tx, receipt validation, seed issuance, honest-run submission, replay
 * verification, rarity assignment, and a real mint transaction from the team
 * minter — then on-chain assertions on the trophy owner and attestation.
 * Skipped when no local chain/deployment is available.
 */
describe('end-to-end on a local EVM', () => {
  let harness: Awaited<ReturnType<typeof setup>> = null

  beforeAll(async () => {
    harness = await setup()
  })

  afterAll(async () => {
    if (harness) await harness.stop()
  })

  it('funds, pays, plays, submits, verifies, and mints a real trophy', async (ctx) => {
    if (!harness) {
      ctx.skip()
      return
    }
    const { base, config, publicClient, player, playerWallet } = harness

    async function api(path: string, body: unknown, token?: string) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    // 1. Faucet + approve + paid entry — real transactions on the local EVM.
    // (The chain may persist between runs: skip the drip when already funded,
    // and only approve when the allowance is short — same logic as the client.)
    const FRONG_ALLOWANCE_ABI = parseAbi([
      'function allowance(address owner, address spender) view returns (uint256)',
    ])
    let balance = await publicClient.readContract({
      address: config.frong as Hex,
      abi: FRONG_ABI,
      functionName: 'balanceOf',
      args: [player.address as Hex],
    })
    if (balance < config.feeAmount) {
      const hash = await playerWallet.writeContract({
        address: config.frong as Hex,
        abi: FRONG_ABI,
        functionName: 'drip',
        account: player,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      balance = await publicClient.readContract({
        address: config.frong as Hex,
        abi: FRONG_ABI,
        functionName: 'balanceOf',
        args: [player.address as Hex],
      })
    }
    expect(balance).toBeGreaterThanOrEqual(config.feeAmount)
    const allowance = await publicClient.readContract({
      address: config.frong as Hex,
      abi: FRONG_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [player.address as Hex, config.entry as Hex],
    })
    let hash: Hex = ('0x' + '00'.repeat(32)) as Hex
    if (allowance < config.feeAmount) {
      hash = await playerWallet.writeContract({
        address: config.frong as Hex,
        abi: FRONG_ABI,
        functionName: 'approve',
        args: [config.entry as Hex, config.feeAmount],
        account: player,
      })
      await publicClient.waitForTransactionReceipt({ hash })
    }
    const paymentId = '0x' + randomBytes(32).toString('hex')
    hash = await playerWallet.writeContract({
      address: config.entry as Hex,
      abi: ENTRY_ABI,
      functionName: 'play',
      args: [paymentId as Hex],
      account: player,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    // The server requires 1 confirmation — mine the next block (real finality).
    await publicClient.request({ method: 'evm_mine', params: [] } as never)

    // 2. Wallet verify (real ECDSA over the exact challenge).
    const challenge = await api('/api/challenge', { address: player.address })
    expect(challenge.status).toBe(200)
    const signature = await player.signMessage({ message: challenge.body.message as string })
    const verify = await api('/api/verify', {
      address: player.address,
      nonce: challenge.body.nonce,
      signature,
    })
    expect(verify.status).toBe(200)
    const authToken = verify.body.authToken as string

    // 3. Session: the server validates the payment against the chain.
    const session = await api('/api/session', { paymentTxHash: hash, paymentId }, authToken)
    expect(session.status).toBe(200)
    const { sessionId, seed, countdownTicks, durationTicks } = session.body as {
      sessionId: string
      seed: number
      countdownTicks: number
      durationTicks: number
    }

    // 4. Honest run: HUMAN-LIKE input log (jittered pointer + keyboard moments).
    // A pure greedy-bot log is correctly rejected by the solver-signature
    // check, so the integration run plays like a person.
    const state = createGame(seed, { countdownTicks, durationTicks })
    const log: InputFrame[] = []
    let jitterState = 1
    while (state.phase !== 'finished') {
      jitterState = (jitterState * 1103515245 + 12345) % 2147483648
      const jitter = ((jitterState % 17) - 8) * 0.6
      const solver = autoInput(state)
      const tick = state.tick
      let input: InputFrame
      if (tick > 0 && tick % 40 === 0) {
        input = { targetX: null, axis: tick % 80 === 0 ? -1 : 1 }
      } else if (tick > 0 && tick % 97 === 0) {
        input = { targetX: null, axis: 0 }
      } else {
        input = { targetX: solver.targetX !== null ? solver.targetX + jitter : 240, axis: 0 }
      }
      log.push(input)
      stepGame(state, input)
    }
    const submit = await api(
      '/api/submit',
      { sessionId, inputLog: log, inputLogHash: hashInputLog(log), buildHash: harness.buildHash },
      authToken,
    )
    expect(submit.status).toBe(200)
    expect(submit.body.status).toBe('accepted')
    expect(submit.body.score).toBe(state.score)
    expect(submit.body.caught).toBe(state.caught)
    const tokenId = submit.body.tokenId as number

    // 5. Mint worker: wait for the real mint transaction.
    let minted = false
    for (let i = 0; i < 30; i += 1) {
      const status = (await (await fetch(base + '/api/status/' + tokenId)).json()) as {
        record: { status: string; txHash: string | null }
      }
      if (status.record.status === 'minted') {
        minted = true
        expect(status.record.txHash).toMatch(/^0x[0-9a-f]{64}$/)
        break
      }
      await wait(1000)
    }
    expect(minted).toBe(true)

    // 6. On-chain assertions — nothing here is faked.
    const owner = await publicClient.readContract({
      address: config.trophy as Hex,
      abi: TROPHY_ABI,
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    })
    expect(owner.toLowerCase()).toBe(player.address.toLowerCase())

    const attestation = await publicClient.readContract({
      address: config.trophy as Hex,
      abi: TROPHY_ABI,
      functionName: 'attestationOf',
      args: [BigInt(tokenId)],
    })
    expect(attestation[1]).toBe(state.score)
    expect(attestation[2]).toBe(state.caught)

    const entryBalance = await publicClient.readContract({
      address: config.frong as Hex,
      abi: FRONG_ABI,
      functionName: 'balanceOf',
      args: [config.entry as Hex],
    })
    expect(entryBalance).toBe(config.feeAmount)

    // 7. The same payment can never fund a second session.
    const again = await api('/api/session', { paymentTxHash: hash, paymentId }, authToken)
    expect(again.status).toBe(402)
    expect(again.body.reason).toBe('payment already used')
  }, 90_000)
})
