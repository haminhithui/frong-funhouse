import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubEnv('VITE_SERVER_URL', 'http://127.0.0.1:8787')

const {
  ApiRequestError,
  fetchGameConfig,
  fetchChallenge,
  verifyWallet,
  requestSession,
  submitRun,
} = await import('../paid/api')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('paid game configuration API', () => {
  it('rejects a non-2xx config response instead of treating its body as config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'maintenance' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    await expect(fetchGameConfig()).rejects.toMatchObject({
      constructor: ApiRequestError,
      status: 503,
    })
  })

  it('rejects a successful response with an invalid config shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    await expect(fetchGameConfig()).rejects.toThrow(/invalid paid-game configuration/i)
  })

  it('rejects config data with invalid contract addresses or build hashes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              chainId: 46630,
              frong: 'not-an-address',
              entry: '0x' + '22'.repeat(20),
              trophy: '0x' + '33'.repeat(20),
              feeAmount: '1000',
              countdownTicks: 1,
              durationTicks: 60,
              buildHash: 'not-a-build-hash',
            }),
            { status: 200 },
          ),
      ),
    )

    await expect(fetchGameConfig()).rejects.toThrow(/invalid paid-game configuration/i)
  })

  it('rejects malformed successful auth, session, and submit responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    )

    await expect(fetchChallenge('0x' + '11'.repeat(20))).rejects.toThrow(/invalid challenge/i)
    await expect(verifyWallet('0x' + '11'.repeat(20), 'nonce', 'signature')).rejects.toThrow(
      /invalid wallet credentials/i,
    )
    await expect(
      requestSession('a'.repeat(64), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32)),
    ).rejects.toThrow(/invalid paid session/i)
    await expect(submitRun('a'.repeat(64), 'session', [], 'hash')).rejects.toThrow(
      /invalid submission result/i,
    )
  })
})
