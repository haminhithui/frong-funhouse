import { describe, expect, it } from 'vitest'
import { issueAuthToken, resolveAuth, AUTH_TOKEN_PERSISTENCE_SCOPE } from '../src/auth'
import { readFileSync } from 'node:fs'
import { Store } from '../src/store'
import { testConfig } from './config'

describe('auth tokens', () => {
  it('binds opaque tokens to a normalized address and advertises the durable adapter', () => {
    expect(AUTH_TOKEN_PERSISTENCE_SCOPE).toBe('durable-adapter')
    const auth = issueAuthToken('0x' + 'AB'.repeat(20), 60_000)
    expect(auth.token).toMatch(/^[0-9a-f]{64}$/)
    expect(resolveAuth('Bearer ' + auth.token)).toBe('0x' + 'ab'.repeat(20))
    expect(resolveAuth('Bearer ' + auth.token.toUpperCase())).toBeNull()
    expect(resolveAuth(undefined)).toBeNull()
  })

  it('survives a server restart when the Store adapter is used', () => {
    const config = testConfig()
    const first = new Store(config.dataDir)
    const issued = issueAuthToken('0x' + 'AB'.repeat(20), 60_000, first)
    const second = new Store(config.dataDir)
    expect(resolveAuth('Bearer ' + issued.token, second)).toBe('0x' + 'ab'.repeat(20))
    const raw = readFileSync(config.dataDir + '/auth.jsonl', 'utf8')
    expect(raw).not.toContain(issued.token)
  })
})
