import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configProblems, deploymentRecordPath, loadConfig } from '../src/config'

describe('server config — testnet 46630 wiring', () => {
  it('points at the testnet deployment record for chain 46630', () => {
    expect(deploymentRecordPath(46630, '/tmp/deployments')).toBe(
      join('/tmp/deployments', 'testnet-46630.json'),
    )
    expect(deploymentRecordPath(4663, '/tmp/deployments')).toBe(
      join('/tmp/deployments', 'mainnet-4663.json'),
    )
    expect(deploymentRecordPath(31337, '/tmp/deployments')).toBe(
      join('/tmp/deployments', 'localhost.json'),
    )
  })

  it('loads addresses, fee, and chain from the testnet record when env is unset', () => {
    const dir = join(tmpdir(), 'frong-config-' + Math.random().toString(36).slice(2))
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(
        join(dir, 'testnet-46630.json'),
        JSON.stringify({
          chainId: 46630,
          frong: '0x' + 'aa'.repeat(20),
          entry: '0x' + 'bb'.repeat(20),
          trophy: '0x' + 'cc'.repeat(20),
          price: '10000000000000000000',
        }),
      )
      const config = loadConfig({ CHAIN_ID: '46630', RPC_URL: 'https://rpc.testnet.example' }, dir)
      expect(config.chainId).toBe(46630)
      expect(config.frong).toBe('0x' + 'aa'.repeat(20))
      expect(config.entry).toBe('0x' + 'bb'.repeat(20))
      expect(config.trophy).toBe('0x' + 'cc'.repeat(20))
      expect(config.feeAmount).toBe(10n * 10n ** 18n)
      expect(configProblems(config)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('NEVER falls back to the localhost record for a real chain', () => {
    const dir = join(tmpdir(), 'frong-config-' + Math.random().toString(36).slice(2))
    mkdirSync(dir, { recursive: true })
    try {
      // Only a localhost record exists; the server is configured for 46630.
      writeFileSync(
        join(dir, 'localhost.json'),
        JSON.stringify({
          chainId: 31337,
          frong: '0x' + '11'.repeat(20),
          entry: '0x' + '22'.repeat(20),
          trophy: '0x' + '33'.repeat(20),
          price: '10000000000000000000',
        }),
      )
      const config = loadConfig({ CHAIN_ID: '46630', RPC_URL: 'https://rpc.testnet.example' }, dir)
      expect(config.frong).toBe('') // no silent localhost fallback
      const problems = configProblems(config)
      expect(problems.some((p) => p.includes('testnet-46630.json'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('env addresses override the deployment record', () => {
    const dir = join(tmpdir(), 'frong-config-' + Math.random().toString(36).slice(2))
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(
        join(dir, 'testnet-46630.json'),
        JSON.stringify({
          chainId: 46630,
          frong: '0x' + 'aa'.repeat(20),
          entry: '0x' + 'bb'.repeat(20),
          trophy: '0x' + 'cc'.repeat(20),
          price: '10000000000000000000',
        }),
      )
      const config = loadConfig(
        {
          CHAIN_ID: '46630',
          RPC_URL: 'https://rpc.testnet.example',
          FRONG_ADDRESS: '0x' + 'dd'.repeat(20),
        },
        dir,
      )
      expect(config.frong).toBe('0x' + 'dd'.repeat(20))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requires explicit production metadata, pinning, CORS, and custody', () => {
    const missing = configProblems(
      loadConfig(
        { CHAIN_ID: '4663', NODE_ENV: 'production' },
        join(tmpdir(), 'missing-deployments'),
      ),
    )
    expect(missing.some((problem) => problem.includes('METADATA_BASE_URL'))).toBe(true)
    expect(missing.some((problem) => problem.includes('PINATA_JWT'))).toBe(true)
    expect(missing.some((problem) => problem.includes('CORS_ORIGINS'))).toBe(true)
    expect(missing.some((problem) => problem.includes('KMS'))).toBe(true)
  })

  it('accepts a complete mainnet production configuration', () => {
    const problems = configProblems(
      loadConfig(
        {
          CHAIN_ID: '4663',
          NODE_ENV: 'production',
          RPC_URL: 'https://rpc.example.test',
          FRONG_ADDRESS: '0x' + 'aa'.repeat(20),
          ENTRY_ADDRESS: '0x' + 'bb'.repeat(20),
          TROPHY_ADDRESS: '0x' + 'cc'.repeat(20),
          FEE_AMOUNT_WEI: '10000000000000000000',
          METADATA_BASE_URL: 'https://metadata.example.test',
          CORS_ORIGINS: 'https://play.example.test',
          PINATA_JWT: 'jwt-test',
          PINATA_GATEWAY: 'https://gateway.example.test',
          KMS_REGION: 'us-east-1',
          KMS_KEY_ID: 'key-1',
          KMS_MINTER_ADDRESS: '0x' + 'dd'.repeat(20),
          OPERATOR_TOKEN: 'operator-test-token-' + 'x'.repeat(32),
          ALLOW_MEMORY_ONLY_AUTH_SESSIONS: 'true',
        },
        join(tmpdir(), 'missing-deployments'),
      ),
    )
    expect(problems).toEqual([])
  })

  it('rejects wildcard, path-bearing, and insecure production CORS origins', () => {
    const problems = configProblems(
      loadConfig(
        {
          CHAIN_ID: '31337',
          NODE_ENV: 'production',
          RPC_URL: 'http://127.0.0.1:8545',
          FRONG_ADDRESS: '0x' + 'aa'.repeat(20),
          ENTRY_ADDRESS: '0x' + 'bb'.repeat(20),
          TROPHY_ADDRESS: '0x' + 'cc'.repeat(20),
          FEE_AMOUNT_WEI: '1',
          METADATA_BASE_URL: 'https://metadata.example.test',
          CORS_ORIGINS: 'https://play.example.test/path',
          PINATA_JWT: 'jwt-test',
          KMS_REGION: 'us-east-1',
          KMS_KEY_ID: 'key-1',
          KMS_MINTER_ADDRESS: '0x' + 'dd'.repeat(20),
          ALLOW_MEMORY_ONLY_AUTH_SESSIONS: 'true',
        },
        join(tmpdir(), 'missing-deployments'),
      ),
    )
    expect(problems.some((problem) => problem.includes('CORS_ORIGINS'))).toBe(true)
  })

  it('rejects invalid ports and non-HTTPS RPC endpoints on real chains', () => {
    const problems = configProblems(
      loadConfig(
        {
          CHAIN_ID: '46630',
          PORT: '70000',
          RPC_URL: 'http://rpc.example.test',
          FRONG_ADDRESS: '0x' + 'aa'.repeat(20),
          ENTRY_ADDRESS: '0x' + 'bb'.repeat(20),
          TROPHY_ADDRESS: '0x' + 'cc'.repeat(20),
          FEE_AMOUNT_WEI: '10000000000000000000',
        },
        join(tmpdir(), 'missing-deployments'),
      ),
    )
    expect(problems.some((problem) => problem.includes('PORT'))).toBe(true)
    expect(problems.some((problem) => problem.includes('public https://'))).toBe(true)
  })

  it('rejects a fee outside the contract price bounds', () => {
    const problems = configProblems(
      loadConfig(
        {
          CHAIN_ID: '31337',
          RPC_URL: 'http://127.0.0.1:8545',
          FRONG_ADDRESS: '0x' + 'aa'.repeat(20),
          ENTRY_ADDRESS: '0x' + 'bb'.repeat(20),
          TROPHY_ADDRESS: '0x' + 'cc'.repeat(20),
          FEE_AMOUNT_WEI: (1_000_001n * 10n ** 18n).toString(),
        },
        join(tmpdir(), 'missing-deployments'),
      ),
    )
    expect(problems.some((problem) => problem.includes('maximum price'))).toBe(true)
  })

  it('reports malformed numeric environment values through config validation', () => {
    const problems = configProblems(
      loadConfig(
        {
          CHAIN_ID: '31337',
          RPC_URL: 'http://127.0.0.1:8545',
          FRONG_ADDRESS: '0x' + 'aa'.repeat(20),
          ENTRY_ADDRESS: '0x' + 'bb'.repeat(20),
          TROPHY_ADDRESS: '0x' + 'cc'.repeat(20),
          FEE_AMOUNT_WEI: 'not-a-number',
          RATE_LIMIT_PER_MIN: '0',
          RATE_LIMIT_BURST: 'NaN',
          CHALLENGE_RATE_PER_MIN: '-1',
        },
        join(tmpdir(), 'missing-deployments'),
      ),
    )
    expect(problems.some((problem) => problem.includes('FEE_AMOUNT_WEI'))).toBe(true)
    expect(problems.some((problem) => problem.includes('RATE_LIMIT_PER_MIN'))).toBe(true)
    expect(problems.some((problem) => problem.includes('RATE_LIMIT_BURST'))).toBe(true)
    expect(problems.some((problem) => problem.includes('CHALLENGE_RATE_PER_MIN'))).toBe(true)
  })
})
