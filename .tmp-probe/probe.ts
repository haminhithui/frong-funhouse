import { createPublicClient } from 'viem'

const s: AbortSignal = AbortSignal.timeout(10)
async function go(): Promise<Response> {
  return fetch('https://x', { method: 'POST', signal: s })
}
const u = new URL('https://x')
export const _ = [go, u, createPublicClient]
