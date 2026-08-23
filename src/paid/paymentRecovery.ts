export interface PendingPayment {
  paymentId: string
  txHash: string
  chainId: number
  player: string
  createdAt: number
}

const STORAGE_KEY = 'frong-catch.pending-payment.v1'
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function isPendingPayment(value: unknown): value is PendingPayment {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.paymentId === 'string' &&
    HASH.test(record.paymentId) &&
    typeof record.txHash === 'string' &&
    HASH.test(record.txHash) &&
    Number.isInteger(record.chainId) &&
    Number(record.chainId) > 0 &&
    typeof record.player === 'string' &&
    ADDRESS.test(record.player) &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt)
  )
}

export function loadPendingPayment(
  storage: Storage | undefined = getStorage(),
): PendingPayment | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return isPendingPayment(value) ? value : null
  } catch {
    return null
  }
}

export function savePendingPayment(
  payment: PendingPayment,
  storage: Storage | undefined = getStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(payment))
  } catch {
    // A full/private browser storage must not turn a submitted payment into a
    // false "not charged" state. The in-memory state still keeps recovery open.
  }
}

export function clearPendingPayment(storage: Storage | undefined = getStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    // Best effort only; a later load will validate the record again.
  }
}

function getStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}
