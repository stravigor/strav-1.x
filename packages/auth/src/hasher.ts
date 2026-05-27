/**
 * `Hasher` — password hashing + verification, backed by `Bun.password`.
 *
 * Argon2id by default. Cost parameters configurable via `config.auth.hasher`;
 * defaults follow OWASP's 2024 recommendation (memory 65536 KiB, t=3, p=4).
 *
 * `needsRehash()` compares the stored hash's encoded parameters against the
 * current configuration. Apps call it after a successful sign-in and re-hash
 * the password (with the new params) when it returns true — this is how cost
 * settings get bumped over time without forcing a global reset.
 */

const ARGON2_ENCODED_PREFIX = /^\$argon2(id|i|d)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/

export interface HasherOptions {
  /** OWASP-aligned defaults; raise as hardware permits. */
  memoryCost?: number
  timeCost?: number
}

export class Hasher {
  private readonly memoryCost: number
  private readonly timeCost: number

  constructor(options: HasherOptions = {}) {
    this.memoryCost = options.memoryCost ?? 65536
    this.timeCost = options.timeCost ?? 3
  }

  /** Hash a plaintext password. Returns the PHC-encoded string for storage. */
  async make(plaintext: string): Promise<string> {
    return Bun.password.hash(plaintext, {
      algorithm: 'argon2id',
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
    })
  }

  /**
   * Constant-time verify. Returns `false` for any non-match (wrong password,
   * malformed hash, algorithm mismatch). Never throws on bad input.
   */
  async verify(plaintext: string, hash: string): Promise<boolean> {
    if (!plaintext || !hash) return false
    try {
      return await Bun.password.verify(plaintext, hash)
    } catch {
      // Bun throws on totally malformed hashes; treat as a failed match.
      return false
    }
  }

  /**
   * `true` when the stored hash was made with weaker parameters than the
   * current config — caller should rehash on next successful sign-in.
   */
  needsRehash(hash: string): boolean {
    const match = ARGON2_ENCODED_PREFIX.exec(hash)
    if (!match) return true // non-argon2 hash → rehash
    const algorithm = match[1]
    const memory = Number(match[2])
    const time = Number(match[3])
    if (algorithm !== 'id') return true
    if (memory < this.memoryCost) return true
    if (time < this.timeCost) return true
    return false
  }
}
