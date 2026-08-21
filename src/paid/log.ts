import type { InputFrame } from '../game/CanvasStage'

/**
 * Canonical input-log hash — MUST match the server's hashInputLog in
 * apps/server/src/verify.ts exactly. This is the run fingerprint engraved in
 * the on-chain attestation.
 */
export async function hashInputLog(log: InputFrame[]): Promise<string> {
  const canonical = JSON.stringify(log.map((frame) => [frame.targetX, frame.axis]))
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Client-generated payment id bound to the Paid event and the session. */
export function newPaymentId(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return (
    '0x' +
    Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  )
}
