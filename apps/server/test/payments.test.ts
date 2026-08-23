import { describe, expect, it } from 'vitest'
import { recoverPaymentSession } from '../src/payments'
import { Store } from '../src/store'
import { testConfig } from './config'

describe('payment/session recovery primitive', () => {
  it('exposes an idempotent recovery result without changing payment validation output', () => {
    const store = new Store(testConfig().dataDir)
    const input = {
      txHash: '0x' + 'aa'.repeat(32),
      player: '0x' + 'bb'.repeat(20),
      paymentId: '0x' + 'cc'.repeat(32),
      buildHash: 'build-a',
      ttlMs: 60_000,
    }
    store.consumePayment(input.txHash, input)
    const first = recoverPaymentSession(store, input)
    const second = recoverPaymentSession(store, input)
    expect(first.ok).toBe(true)
    expect(second).toEqual({
      ok: true,
      created: false,
      session: first.ok ? first.session : undefined,
    })
  })
})
