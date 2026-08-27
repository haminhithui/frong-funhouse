/**
 * Focused tests for the Worker-side environment validation helper
 * (src/config.ts). Runs on Node's built-in test runner:
 *
 *   node --test apps/worker/test/config.test.ts
 *
 * The helper is pure: every case injects its bindings explicitly and nothing
 * reads process.env. All addresses and URLs are clearly fake fixtures
 * (`0x…` repeated-hex wallets, `*.test.example` hosts on the reserved
 * documentation TLD) — no real endpoint or deployed contract is referenced.
 * FEE_AMOUNT_WEI is deliberately absent from the contract under test: the
 * only payment truth is the live on-chain `price()` read, never a stale var.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadWorkerConfig, type Env } from '../src/config.ts'

// ---- clearly fake fixtures -------------------------------------------------

const addr = (byte: string) => '0x' + byte.repeat(20)
const FRONG = addr('aa')
const ENTRY = addr('bb')
const TROPHY = addr('cc')
const BUILD_HASH = 'ab'.repeat(32)
const RPC_TESTNET = 'https://rpc-fixture.test.example' // reserved docs TLD
const RPC_MAINNET = 'https://rpc-mainnet-fixture.test.example'

function stagingEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'staging',
    NETWORK: 'testnet',
    CHAIN_ID: '46630',
    RPC_URL: RPC_TESTNET,
    FRONG_ADDRESS: FRONG,
    ENTRY_ADDRESS: ENTRY,
    TROPHY_ADDRESS: TROPHY,
    BUILD_HASH,
    ...overrides,
  }
}

function productionEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: 'production',
    NETWORK: 'mainnet',
    CHAIN_ID: '4663',
    RPC_URL: RPC_MAINNET,
    FRONG_ADDRESS: FRONG,
    ENTRY_ADDRESS: ENTRY,
    TROPHY_ADDRESS: TROPHY,
    BUILD_HASH,
    ...overrides,
  }
}

const problemsOf = (res: ReturnType<typeof loadWorkerConfig>): string[] =>
  res.ok ? [] : res.problems

// ---- valid environments ----------------------------------------------------

test('valid staging env: ok with the fully typed testnet config', () => {
  const res = loadWorkerConfig(stagingEnv())
  assert.ok(res.ok)
  assert.deepEqual(res.config, {
    appEnv: 'staging',
    chainId: 46630,
    network: 'testnet',
    rpcUrl: RPC_TESTNET,
    frong: FRONG,
    entry: ENTRY,
    trophy: TROPHY,
    buildHash: BUILD_HASH,
    countdownTicks: 180, // documented default when the var is unset
    durationTicks: 3600, // documented default when the var is unset
  })
})

test('valid production env: ok with the mainnet 4663 config', () => {
  const res = loadWorkerConfig(productionEnv({ COUNTDOWN_TICKS: '90', DURATION_TICKS: '7200' }))
  assert.ok(res.ok)
  assert.equal(res.config.appEnv, 'production')
  assert.equal(res.config.chainId, 4663)
  assert.equal(res.config.network, 'mainnet')
  assert.equal(res.config.rpcUrl, RPC_MAINNET)
  assert.equal(res.config.countdownTicks, 90)
  assert.equal(res.config.durationTicks, 7200)
})

test('checksummed (mixed-case) addresses are normalized to lowercase', () => {
  const mixed = '0x' + 'Aa'.repeat(20) // 40 hex chars, mixed case
  const res = loadWorkerConfig(stagingEnv({ FRONG_ADDRESS: mixed }))
  assert.ok(res.ok)
  assert.equal(res.config.frong, mixed.toLowerCase())
})

// ---- contract addresses ----------------------------------------------------

test('missing address is reported per key (all three at once)', () => {
  const env = stagingEnv()
  delete env.FRONG_ADDRESS
  delete env.ENTRY_ADDRESS
  delete env.TROPHY_ADDRESS
  const res = loadWorkerConfig(env)
  assert.equal(res.ok, false)
  const problems = problemsOf(res)
  for (const key of ['FRONG_ADDRESS', 'ENTRY_ADDRESS', 'TROPHY_ADDRESS']) {
    assert.ok(
      problems.some((p) => p.startsWith(key + ' ')),
      `problem for ${key}`,
    )
  }
  assert.equal(problems.length, 3)
})

test('malformed and zero addresses are invalid', () => {
  for (const bad of ['0x123', 'nope', '0x' + '0'.repeat(40), '0x' + 'gg'.repeat(20)]) {
    const res = loadWorkerConfig(stagingEnv({ ENTRY_ADDRESS: bad }))
    assert.equal(res.ok, false, `entry=${bad}`)
    assert.ok(problemsOf(res).some((p) => p.startsWith('ENTRY_ADDRESS ')))
  }
})

// ---- chain id --------------------------------------------------------------

test('chain id outside 46630/4663 (and 31337) is rejected', () => {
  for (const bad of ['1', '46631', '0', 'abc', '']) {
    const res = loadWorkerConfig(stagingEnv({ CHAIN_ID: bad }))
    assert.equal(res.ok, false, `chain=${JSON.stringify(bad)}`)
    assert.ok(problemsOf(res).some((p) => p.startsWith('CHAIN_ID ')))
  }
})

test('staging on mainnet 4663 and production on testnet 46630 are rejected', () => {
  const stagingOnMainnet = loadWorkerConfig(stagingEnv({ CHAIN_ID: '4663', NETWORK: 'mainnet' }))
  assert.equal(stagingOnMainnet.ok, false)
  assert.ok(
    problemsOf(stagingOnMainnet).includes('APP_ENV staging requires CHAIN_ID 46630 (testnet)'),
  )

  const prodOnTestnet = loadWorkerConfig(productionEnv({ CHAIN_ID: '46630', NETWORK: 'testnet' }))
  assert.equal(prodOnTestnet.ok, false)
  assert.ok(
    problemsOf(prodOnTestnet).includes('APP_ENV production requires CHAIN_ID 4663 (mainnet)'),
  )
})

test('NETWORK label must match the chain when set', () => {
  const res = loadWorkerConfig(stagingEnv({ NETWORK: 'mainnet' }))
  assert.equal(res.ok, false)
  assert.ok(problemsOf(res).includes('NETWORK must be testnet for CHAIN_ID 46630'))
})

// ---- RPC URL ---------------------------------------------------------------

test('non-URL and non-http(s) RPC endpoints are rejected', () => {
  for (const bad of ['', 'not-a-url', 'ftp://rpc-fixture.test.example', 'rpc.test.example/rpc']) {
    const res = loadWorkerConfig(stagingEnv({ RPC_URL: bad }))
    assert.equal(res.ok, false, `rpc=${JSON.stringify(bad)}`)
    assert.ok(problemsOf(res).some((p) => p.startsWith('RPC_URL ')))
  }
})

test('a real chain (46630/4663) requires a public https RPC: plain http and loopback are rejected', () => {
  const http = loadWorkerConfig(stagingEnv({ RPC_URL: 'http://rpc-fixture.test.example' }))
  assert.equal(http.ok, false)
  assert.ok(problemsOf(http).includes('RPC_URL for a real chain must be a public https:// URL'))

  const loopback = loadWorkerConfig(productionEnv({ RPC_URL: 'https://localhost:8545' }))
  assert.equal(loopback.ok, false)
  assert.ok(problemsOf(loopback).includes('RPC_URL for a real chain must be a public https:// URL'))
})

test('local dev (31337) keeps http + loopback RPC available, but never mainnet', () => {
  const localEnv = stagingEnv({
    APP_ENV: 'local',
    CHAIN_ID: '31337',
    RPC_URL: 'http://localhost:8545',
  })
  delete localEnv.NETWORK
  const local = loadWorkerConfig(localEnv)
  assert.ok(local.ok)
  assert.equal(local.config.chainId, 31337)

  const localOnMainnet = loadWorkerConfig(
    stagingEnv({ APP_ENV: 'local', CHAIN_ID: '4663', NETWORK: 'mainnet', RPC_URL: RPC_MAINNET }),
  )
  assert.equal(localOnMainnet.ok, false)
  assert.ok(
    problemsOf(localOnMainnet).includes(
      'APP_ENV local cannot target mainnet 4663; use the production env',
    ),
  )
})

// ---- fail-closed behavior, purity, and FEE_AMOUNT_WEI ----------------------

test('empty bindings fail closed listing every required var', () => {
  const res = loadWorkerConfig({})
  assert.equal(res.ok, false)
  const problems = problemsOf(res)
  for (const prefix of [
    'APP_ENV ',
    'CHAIN_ID ',
    'RPC_URL ',
    'FRONG_ADDRESS ',
    'ENTRY_ADDRESS ',
    'TROPHY_ADDRESS ',
    'BUILD_HASH ',
  ]) {
    assert.ok(
      problems.some((p) => p.startsWith(prefix)),
      `problem for ${prefix}`,
    )
  }
  // defaults are still well-formed (they were never the failure)
  assert.ok(!problems.some((p) => p.startsWith('COUNTDOWN_TICKS')))
  assert.ok(!problems.some((p) => p.startsWith('DURATION_TICKS')))
})

test('FEE_AMOUNT_WEI is not part of the contract: ignored, no fee field in the config', () => {
  // spread (not a literal key) so the extra var rides along without being
  // part of the typed Env surface under test
  const staleFeeVar: Record<string, string> = { FEE_AMOUNT_WEI: '999' }
  const withFee = loadWorkerConfig({ ...stagingEnv(), ...staleFeeVar })
  const withoutFee = loadWorkerConfig(stagingEnv())
  assert.deepEqual(withFee, withoutFee) // the var changes nothing at all
  assert.ok(withFee.ok)
  assert.ok(
    !Object.keys(withFee.config).some((k) => k.toLowerCase().includes('fee')),
    'no fee amount may be carried as env-derived payment truth',
  )
})

test('pure and injectable: deterministic, does not mutate the injected env, ignores process.env', () => {
  const env = stagingEnv()
  Object.freeze(env)
  const first = loadWorkerConfig(env)
  const second = loadWorkerConfig(env)
  assert.deepEqual(first, second) // same bindings in, same result out

  // A fully populated process.env must not leak into an empty binding set:
  // the helper reads only what the caller injects.
  const keys = [
    'APP_ENV',
    'ENVIRONMENT',
    'NETWORK',
    'CHAIN_ID',
    'RPC_URL',
    'FRONG_ADDRESS',
    'ENTRY_ADDRESS',
    'TROPHY_ADDRESS',
    'BUILD_HASH',
    'FEE_AMOUNT_WEI',
  ] as const
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  try {
    process.env.APP_ENV = 'staging'
    process.env.CHAIN_ID = '46630'
    process.env.RPC_URL = RPC_TESTNET
    process.env.FEE_AMOUNT_WEI = '1'
    process.env.FROMG_ADDRESS = FRONG
    process.env.FRON_ADDRESS = FRONG // typo'd keys must not satisfy validation either
    const res = loadWorkerConfig({})
    assert.equal(res.ok, false)
    assert.ok(problemsOf(res).some((p) => p.startsWith('FRONG_ADDRESS ')))
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    delete process.env.FROMG_ADDRESS
    delete process.env.FRON_ADDRESS
  }
})
