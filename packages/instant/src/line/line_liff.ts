/**
 * LIFF ID-token verification.
 *
 * LIFF apps run client-side inside LINE's in-app webview. The
 * frontend obtains an ID token via `liff.getIDToken()` and posts it
 * to the backend; the backend MUST verify the token with LINE
 * (signature, audience, expiry) before trusting any claim from it.
 *
 * `verifyIdToken` POSTs to `https://api.line.me/oauth2/v2.1/verify`
 * with the channel id as `client_id`. LINE returns the decoded
 * claims (`sub`, `name`, `picture`, `email` when the user
 * consented to the email scope) when the token is valid; we throw
 * `InstantProviderError` otherwise.
 *
 * Never trust a userId received directly from a LIFF frontend —
 * always validate via this helper first.
 */

import { InstantProviderError } from '../errors.ts'

const LINE_VERIFY_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify'

export interface LiffIdTokenClaims {
  /** LINE user id (`sub` claim — same as `userId` from Messaging API). */
  sub: string
  /** Display name. Always present when the token is valid. */
  name?: string
  /** Profile picture URL. Present when the user has one. */
  picture?: string
  /** Email — only present when the channel has the `email` scope and the user consented. */
  email?: string
  /** Audience claim — should equal the channel id we passed. */
  aud: string
  /** Issuer (`https://access.line.me`). */
  iss: string
  /** Expiry (seconds since epoch). */
  exp: number
  /** Issued-at (seconds since epoch). */
  iat: number
  /** Raw claims object from LINE — keep the rest for advanced cases. */
  raw: Record<string, unknown>
}

export interface VerifyIdTokenOptions {
  /** Required nonce match — LINE's response must echo this value. */
  nonce?: string
  /** Required user id match — convenience check on top of `sub`. */
  userId?: string
  /** Override the verify endpoint (tests). */
  endpoint?: string
}

export class LineLiff {
  constructor(private readonly channelId: string) {
    if (!channelId) {
      throw new InstantProviderError(
        'LineLiff: `channelId` is required for ID-token verification.',
        {
          provider: 'line',
          operation: 'liff.verifyIdToken',
          status: 500,
        },
      )
    }
  }

  async verifyIdToken(
    idToken: string,
    options: VerifyIdTokenOptions = {},
  ): Promise<LiffIdTokenClaims> {
    const body = new URLSearchParams({ id_token: idToken, client_id: this.channelId })
    if (options.nonce) body.set('nonce', options.nonce)
    if (options.userId) body.set('user_id', options.userId)

    const response = await fetch(options.endpoint ?? LINE_VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok || !payload) {
      throw new InstantProviderError('LineLiff: ID-token verification failed.', {
        provider: 'line',
        operation: 'liff.verifyIdToken',
        status: response.status,
        context: { response: payload },
      })
    }
    return {
      sub: String(payload.sub ?? ''),
      ...(payload.name ? { name: String(payload.name) } : {}),
      ...(payload.picture ? { picture: String(payload.picture) } : {}),
      ...(payload.email ? { email: String(payload.email) } : {}),
      aud: String(payload.aud ?? ''),
      iss: String(payload.iss ?? ''),
      exp: Number(payload.exp ?? 0),
      iat: Number(payload.iat ?? 0),
      raw: payload,
    }
  }
}
