import { describe, expect, it } from 'vitest'
import { restoreSession, SESSION_PERSISTENCE_SCOPE } from '../src/sessions'

describe('durable payment-bound session adapter', () => {
  it('restores without extending expiry', () => {
    expect(SESSION_PERSISTENCE_SCOPE).toBe('durable-payment-binding')
    const now = Date.now()
    const recovered = {
      sessionId: 'recovery-' + now,
      player: '0x' + 'AB'.repeat(20),
      paymentTxHash: '0x' + 'CD'.repeat(32),
      paymentId: '0x' + 'EF'.repeat(32),
      seed: 123,
      buildHash: 'build-a',
      createdAt: now,
      expiresAt: now + 60_000,
    }

    const session = restoreSession(recovered)
    expect(session).toMatchObject({
      ...recovered,
      player: recovered.player.toLowerCase(),
      paymentTxHash: recovered.paymentTxHash.toLowerCase(),
      paymentId: recovered.paymentId.toLowerCase(),
      consumed: false,
    })
    expect(restoreSession(recovered)).toBe(session)
    expect(
      restoreSession({
        ...recovered,
        sessionId: recovered.sessionId + '-expired',
        expiresAt: now - 1,
      }),
    ).toBeUndefined()
  })
})
