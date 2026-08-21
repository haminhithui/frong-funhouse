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
})
