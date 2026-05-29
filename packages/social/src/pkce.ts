/**
 * PKCE (Proof Key for Code Exchange) helpers — RFC 7636.
 *
 * For public clients (mobile, SPA, even server-side apps that
 * can't keep a "client secret" truly secret), PKCE makes the
 * authorization code worthless to an attacker who intercepts it
 * mid-flight. Google requires PKCE on all new flows; Line supports
 * it; Facebook ignores it.
 *
 * Flow:
 *
 *   1. `randomCodeVerifier()` → high-entropy random string.
 *      Apps store this against the user's session for the
 *      callback step.
 *   2. `codeChallengeFor(verifier)` → base64url(sha256(verifier)).
 *      Drivers include this on the authorize URL as
 *      `code_challenge` + `code_challenge_method=S256`.
 *   3. On callback, apps pass the stored verifier into
 *      `driver.exchange({...codeVerifier})`. The provider
 *      hashes it again and rejects the exchange if the hashes
 *      don't match.
 *
 * Plain (S256-only) implementation — we never emit `method=plain`.
 */

const VERIFIER_LENGTH = 64 // RFC allows 43–128; 64 is comfortably above floor.

/**
 * Cryptographically-strong random verifier (URL-safe alphabet).
 * 64 chars at 6 bits/char ≈ 384 bits of entropy.
 */
export function randomCodeVerifier(): string {
  const bytes = new Uint8Array(VERIFIER_LENGTH)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes).slice(0, VERIFIER_LENGTH)
}

/** SHA-256 → base64url. The challenge the provider stores until callback. */
export async function codeChallengeFor(verifier: string): Promise<string> {
  const buf = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return base64UrlEncode(new Uint8Array(hash))
}

/**
 * Random state — opaque CSRF token apps include on the
 * authorize URL and verify on the callback. Drivers expose the
 * verification helper (`assertStateMatches`) so apps don't
 * have to roll the comparison themselves.
 */
export function randomState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

function base64UrlEncode(bytes: Uint8Array): string {
  // btoa needs a binary string; Bun + browsers + Node 18+ all
  // handle this idiom identically.
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
