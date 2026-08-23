import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPendingPayment,
  loadPendingPayment,
  savePendingPayment,
  type PendingPayment,
} from '../paid/paymentRecovery'

const payment: PendingPayment = {
  paymentId: '0x' + '11'.repeat(32),
  txHash: '0x' + '22'.repeat(32),
  chainId: 46630,
  player: '0x' + '33'.repeat(20),
  createdAt: 1_700_000_000_000,
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('pending payment recovery', () => {
  it('round-trips a submitted payment through browser storage', () => {
    savePendingPayment(payment)
    expect(loadPendingPayment()).toEqual(payment)

    clearPendingPayment()
    expect(loadPendingPayment()).toBeNull()
  })

  it('rejects malformed or mismatched storage data', () => {
    window.localStorage.setItem(
      'frong-catch.pending-payment.v1',
      JSON.stringify({ ...payment, txHash: 'not-a-hash' }),
    )
    expect(loadPendingPayment()).toBeNull()

    window.localStorage.setItem('frong-catch.pending-payment.v1', '{broken json')
    expect(loadPendingPayment()).toBeNull()
  })

  it('keeps the runtime recovery path alive when storage is unavailable', () => {
    const failingStorage = {
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('private mode')
      },
      removeItem: () => {
        throw new Error('private mode')
      },
    } as unknown as Storage

    expect(loadPendingPayment(failingStorage)).toBeNull()
    expect(() => savePendingPayment(payment, failingStorage)).not.toThrow()
    expect(() => clearPendingPayment(failingStorage)).not.toThrow()
  })
})
