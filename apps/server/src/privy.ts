import { createPublicKey } from 'node:crypto'
import { PrivyClient } from '@privy-io/server-auth'
import type { ServerConfig } from './config'

export interface PrivyVerifier {
  /**
   * Verifies BOTH Privy tokens: the access token proves the session
   * (signature + claims against the verification key), the identity token
   * proves which wallets are linked to that user.
   */
  verify(
    address: string,
    accessToken: string,
    idToken: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; reason: string }>
}

/**
 * Server-side Privy verification: the Privy JWT proves the USER (social
 * login), and the wallet must be one of that user's linked accounts.
 *
 * Two supported configurations:
 *  - app id + app secret: the SDK may reach the Privy API for the app
 *    verification key.
 *  - app id + verification key (no secret): everything is verified LOCALLY.
 *    verifyAuthToken checks the ES256 signature/claims with the public key,
 *    and getUser({idToken}) reads the wallet linkage from the token's own
 *    linked_accounts claim — no Privy API call is made. The secret is only
 *    needed for API methods this verifier never calls.
 *
 * Returns null when Privy is not configured — the endpoint then answers 503,
 * never fakes a verification.
 */
export function createPrivyVerifier(config: ServerConfig): PrivyVerifier | null {
  if (!config.privyAppId) return null
  if (!config.privyAppSecret && !config.privyVerificationKey) return null
  if (config.privyVerificationKey) {
    // Fail LOUD at boot when the configured key cannot parse — a mangled key
    // would otherwise surface as a silent 401 for every real login.
    try {
      createPublicKey({ key: config.privyVerificationKey, format: 'pem' })
    } catch {
      console.error(
        '[privy] PRIVY_VERIFICATION_KEY is set but is not a valid PEM public key — Privy login disabled',
      )
      return null
    }
  }
  const client = new PrivyClient(config.privyAppId, config.privyAppSecret ?? '')
  if (!config.privyAppSecret && config.privyVerificationKey) {
    // getUser({idToken}) resolves the key through getVerificationKey(), which
    // would hit the Privy API; pre-seed the SDK's cache so key-only mode stays
    // fully offline. The field is a plain JS class property (typed private).
    ;(client as unknown as { verificationKey: string | null }).verificationKey =
      config.privyVerificationKey
  }
  return {
    verify: async (address, accessToken, idToken) => {
      let claims: Awaited<ReturnType<typeof client.verifyAuthToken>>
      try {
        // The ACCESS token: signature + claims against the verification key.
        claims = await client.verifyAuthToken(accessToken, config.privyVerificationKey ?? undefined)
      } catch {
        return { ok: false, reason: 'access token signature or claims invalid' }
      }
      let user: Awaited<ReturnType<typeof client.getUser>>
      try {
        // The IDENTITY token: carries linked_accounts; parsed locally.
        user = await client.getUser({ idToken })
      } catch {
        return { ok: false, reason: 'identity token invalid' }
      }
      if (user.id !== claims.userId) {
        return { ok: false, reason: 'access and identity tokens belong to different users' }
      }
      const linked = (user.linkedAccounts ?? [])
        .filter((account) => account.type === 'wallet')
        .map((account) => {
          const wallet = account as { address?: string }
          return wallet.address ? wallet.address.toLowerCase() : null
        })
        .filter((value): value is string => value !== null)
      if (!linked.includes(address.toLowerCase())) {
        return { ok: false, reason: 'wallet is not linked to the verified Privy account' }
      }
      return { ok: true, userId: claims.userId }
    },
  }
}
