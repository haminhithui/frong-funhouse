import { SERVER_URL } from './config'
import type { InputFrame } from '../game/CanvasStage'

export interface GameConfigResponse {
  chainId: number
  frong: string
  entry: string
  trophy: string
  feeAmount: string
  countdownTicks: number
  durationTicks: number
  buildHash: string
}

export interface SessionResponse {
  sessionId: string
  seed: number
  buildHash: string
  expiresAt: number
  countdownTicks: number
  durationTicks: number
}

export interface SubmitResponse {
  status: 'accepted'
  tokenId: number
  tier: { index: number; name: string; slug: string }
  score: number
  caught: number
  missed: number
}

export interface MintStatusResponse {
  record: {
    tokenId: number
    status: 'queued' | 'minting' | 'minted' | 'delayed' | 'rejected'
    tierName: string
    score: number
    fliesCaught: number
    txHash: string | null
    uri: string
  }
}

export interface ApiError {
  error: string
  reason?: string
}

async function post<T>(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
  const res = await fetch(SERVER_URL + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  })
  let parsed: T
  try {
    parsed = (await res.json()) as T
  } catch {
    parsed = {} as T
  }
  return { status: res.status, body: parsed }
}

export function fetchGameConfig(): Promise<GameConfigResponse> {
  return fetch(SERVER_URL + '/api/config').then((res) => res.json() as Promise<GameConfigResponse>)
}

export function fetchChallenge(address: string) {
  return post<{ nonce: string; message: string }>('/api/challenge', { address })
}

/**
 * Server-side Privy verification. TWO tokens are required:
 *  - accessToken (getAccessToken): signature/claims verified against the app
 *    verification key via Privy's verifyAuthToken.
 *  - idToken (getIdentityToken): carries the linked_accounts claim; the server
 *    proves the wallet belongs to the user from it.
 */
export function verifyPrivy(address: string, accessToken: string, idToken: string) {
  return post<{ authToken: string; expiresAt: number; address: string } | ApiError>(
    '/api/verify/privy',
    { address, accessToken, idToken },
  )
}

export function verifyWallet(address: string, nonce: string, signature: string) {
  return post<{ authToken: string; expiresAt: number }>('/api/verify', {
    address,
    nonce,
    signature,
  })
}

export function requestSession(authToken: string, paymentTxHash: string, paymentId: string) {
  return post<SessionResponse | ApiError>('/api/session', { paymentTxHash, paymentId }, authToken)
}

export function submitRun(
  authToken: string,
  sessionId: string,
  inputLog: InputFrame[],
  inputLogHash: string,
) {
  return post<SubmitResponse | ApiError>(
    '/api/submit',
    { sessionId, inputLog, inputLogHash, buildHash: import.meta.env.VITE_SIM_BUILD_HASH ?? '' },
    authToken,
  )
}

export function fetchMintStatus(tokenId: number): Promise<MintStatusResponse> {
  return fetch(SERVER_URL + '/api/status/' + tokenId).then(
    (res) => res.json() as Promise<MintStatusResponse>,
  )
}
