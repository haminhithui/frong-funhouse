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
  consumed?: boolean
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

interface ChallengeResponse {
  nonce: string
  message: string
}

interface AuthResponse {
  authToken: string
  expiresAt: number
  address?: string
}

export class ApiRequestError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
  }
}

const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BUILD_HASH = /^[0-9a-f]{64}$/

function isNonZeroAddress(value: string): boolean {
  return ETH_ADDRESS.test(value) && !/^0x0{40}$/i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isApiError(value: unknown): value is ApiError {
  return isRecord(value) && typeof value.error === 'string'
}

function isChallengeResponse(value: unknown): value is ChallengeResponse {
  return (
    isRecord(value) &&
    typeof value.nonce === 'string' &&
    value.nonce.length > 0 &&
    typeof value.message === 'string' &&
    value.message.length > 0
  )
}

function isAuthResponse(value: unknown): value is AuthResponse {
  return (
    isRecord(value) &&
    typeof value.authToken === 'string' &&
    /^[0-9a-f]{64}$/.test(value.authToken) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    (value.address === undefined || typeof value.address === 'string')
  )
}

function isGameConfigResponse(value: unknown): value is GameConfigResponse {
  if (!isRecord(value)) return false
  return (
    Number.isInteger(value.chainId) &&
    [31337, 46630, 4663].includes(Number(value.chainId)) &&
    typeof value.frong === 'string' &&
    isNonZeroAddress(value.frong) &&
    typeof value.entry === 'string' &&
    isNonZeroAddress(value.entry) &&
    typeof value.trophy === 'string' &&
    isNonZeroAddress(value.trophy) &&
    typeof value.feeAmount === 'string' &&
    /^\d+$/.test(value.feeAmount) &&
    BigInt(value.feeAmount) > 0n &&
    Number.isInteger(value.countdownTicks) &&
    Number(value.countdownTicks) >= 0 &&
    Number.isInteger(value.durationTicks) &&
    Number(value.durationTicks) > 0 &&
    typeof value.buildHash === 'string' &&
    BUILD_HASH.test(value.buildHash)
  )
}

function isSessionResponse(value: unknown): value is SessionResponse {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    Number.isInteger(value.seed) &&
    Number(value.seed) >= 0 &&
    Number(value.seed) <= 0xffffffff &&
    typeof value.buildHash === 'string' &&
    BUILD_HASH.test(value.buildHash) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    (value.consumed === undefined || typeof value.consumed === 'boolean') &&
    Number.isInteger(value.countdownTicks) &&
    Number(value.countdownTicks) >= 0 &&
    Number.isInteger(value.durationTicks) &&
    Number(value.durationTicks) > 0
  )
}

function isSubmitResponse(value: unknown): value is SubmitResponse {
  if (!isRecord(value) || value.status !== 'accepted' || !isRecord(value.tier)) return false
  return (
    Number.isInteger(value.tokenId) &&
    Number(value.tokenId) > 0 &&
    Number.isInteger(value.tier.index) &&
    Number(value.tier.index) >= 0 &&
    Number(value.tier.index) <= 5 &&
    typeof value.tier.name === 'string' &&
    typeof value.tier.slug === 'string' &&
    Number.isInteger(value.score) &&
    Number(value.score) >= 0 &&
    Number(value.score) <= 109 &&
    Number.isInteger(value.caught) &&
    Number(value.caught) >= 0 &&
    Number(value.caught) <= 45 &&
    Number.isInteger(value.missed) &&
    Number(value.missed) >= 0 &&
    Number(value.missed) <= 45
  )
}

function isMintStatusResponse(value: unknown): value is MintStatusResponse {
  if (!isRecord(value) || !isRecord(value.record)) return false
  const record = value.record
  return (
    Number.isInteger(record.tokenId) &&
    Number(record.tokenId) > 0 &&
    typeof record.status === 'string' &&
    ['queued', 'minting', 'minted', 'delayed', 'rejected'].includes(record.status) &&
    typeof record.tierName === 'string' &&
    Number.isInteger(record.score) &&
    Number.isInteger(record.fliesCaught) &&
    (record.txHash === null || typeof record.txHash === 'string') &&
    typeof record.uri === 'string'
  )
}

async function readJson<T>(res: Response, path: string): Promise<T> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // The status code is still authoritative when a server returns no JSON.
  }

  if (!res.ok) {
    const detail = isRecord(body) && typeof body.error === 'string' ? `: ${body.error}` : ''
    throw new ApiRequestError(`Request ${path} failed with HTTP ${res.status}${detail}`, res.status)
  }

  return body as T
}

async function post<T>(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: T | ApiError }> {
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
  if (!res.ok) {
    return {
      status: res.status,
      body: isApiError(parsed)
        ? parsed
        : { error: `Request ${path} failed with HTTP ${res.status}` },
    }
  }
  return { status: res.status, body: parsed }
}

export async function fetchGameConfig(): Promise<GameConfigResponse> {
  let res: Response
  try {
    res = await fetch(SERVER_URL + '/api/config')
  } catch {
    throw new ApiRequestError('Could not reach the game server while loading configuration.')
  }
  const body = await readJson<unknown>(res, '/api/config')
  if (!isGameConfigResponse(body)) {
    throw new ApiRequestError(
      'The game server returned an invalid paid-game configuration.',
      res.status,
    )
  }
  return body
}

export async function fetchChallenge(address: string) {
  const result = await post<ChallengeResponse>('/api/challenge', { address })
  if (result.status >= 200 && result.status < 300 && !isChallengeResponse(result.body)) {
    throw new ApiRequestError('The game server returned an invalid challenge.', result.status)
  }
  return result
}

/**
 * Server-side Privy verification. TWO tokens are required:
 *  - accessToken (getAccessToken): signature/claims verified against the app
 *    verification key via Privy's verifyAuthToken.
 *  - idToken (getIdentityToken): carries the linked_accounts claim; the server
 *    proves the wallet belongs to the user from it.
 */
export async function verifyPrivy(address: string, accessToken: string, idToken: string) {
  const result = await post<AuthResponse>('/api/verify/privy', {
    address,
    accessToken,
    idToken,
  })
  if (result.status >= 200 && result.status < 300 && !isAuthResponse(result.body)) {
    throw new ApiRequestError('The game server returned invalid Privy credentials.', result.status)
  }
  return result
}

export async function verifyWallet(address: string, nonce: string, signature: string) {
  const result = await post<AuthResponse>('/api/verify', {
    address,
    nonce,
    signature,
  })
  if (result.status >= 200 && result.status < 300 && !isAuthResponse(result.body)) {
    throw new ApiRequestError('The game server returned invalid wallet credentials.', result.status)
  }
  return result
}

export async function requestSession(authToken: string, paymentTxHash: string, paymentId: string) {
  const result = await post<SessionResponse>(
    '/api/session',
    { paymentTxHash, paymentId },
    authToken,
  )
  if (result.status >= 200 && result.status < 300 && !isSessionResponse(result.body)) {
    throw new ApiRequestError('The game server returned an invalid paid session.', result.status)
  }
  return result
}

export async function submitRun(
  authToken: string,
  sessionId: string,
  inputLog: InputFrame[],
  inputLogHash: string,
) {
  const result = await post<SubmitResponse>(
    '/api/submit',
    { sessionId, inputLog, inputLogHash, buildHash: import.meta.env.VITE_SIM_BUILD_HASH ?? '' },
    authToken,
  )
  if (result.status >= 200 && result.status < 300 && !isSubmitResponse(result.body)) {
    throw new ApiRequestError(
      'The game server returned an invalid submission result.',
      result.status,
    )
  }
  return result
}

export async function fetchMintStatus(
  tokenId: number,
  authToken: string,
): Promise<MintStatusResponse> {
  let res: Response
  try {
    res = await fetch(SERVER_URL + '/api/status/' + tokenId, {
      headers: { Authorization: 'Bearer ' + authToken },
    })
  } catch {
    throw new ApiRequestError('Could not reach the game server while loading mint status.')
  }
  const body = await readJson<unknown>(res, '/api/status/' + tokenId)
  if (!isMintStatusResponse(body)) {
    throw new ApiRequestError('The game server returned an invalid mint status.', res.status)
  }
  return body
}
