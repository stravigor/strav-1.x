/**
 * Typed configuration repository.
 *
 * Built from the merged result of every `config/*.ts` file. Accessed via
 * dotted paths (`config.get('database.tenant.bypass.username')`) or typed
 * sub-trees (`config.section<DbConfig>('database')`).
 *
 * **Frozen after boot.** The `ConfigProvider` listens for `app:booted` and
 * calls `freeze()`. After that, `set()` throws — config is the source of
 * truth for the rest of the process's life.
 *
 * @see docs/kernel/api.md
 * @see spec/config-and-env.md
 */

export type ConfigData = Record<string, unknown>

export class ConfigRepository {
  private data: ConfigData
  private frozen = false

  constructor(data: ConfigData = {}) {
    this.data = clone(data)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Read a value by dotted path. Returns `defaultValue` (or `undefined`)
   * when the path is missing.
   */
  get(key: string): unknown
  get<T>(key: string, defaultValue: T): T
  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = this.read(key)
    return (value === undefined ? defaultValue : value) as T | undefined
  }

  /** Does the dotted path resolve to a value (other than `undefined`)? */
  has(key: string): boolean {
    return this.read(key) !== undefined
  }

  /**
   * Read a typed sub-tree. Useful for handing a slice of config to a provider
   * or service without re-reading the dotted paths one by one.
   *
   * Returned object is read-only at the type level. (Deep freeze is not done
   * for performance; the freeze contract is enforced via `set()`.)
   */
  section<T = ConfigData>(key: string): T {
    const value = this.read(key)
    if (value === undefined) {
      throw new Error(`ConfigRepository: no section at "${key}".`)
    }
    return value as T
  }

  /** Return the full config snapshot (cloned to prevent external mutation). */
  all(): ConfigData {
    return clone(this.data)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Write
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Set a value by dotted path. Intermediate path segments are created as
   * empty objects if missing.
   *
   * Throws after `freeze()` has been called.
   */
  set(key: string, value: unknown): this {
    if (this.frozen) {
      throw new Error(
        `ConfigRepository: cannot set "${key}" — configuration is frozen after app:booted.`,
      )
    }
    this.write(key, value)
    return this
  }

  /**
   * Merge an object of dotted-path → value entries.
   * Useful in tests: `config.merge({ 'app.name': 'test', 'db.host': 'x' })`.
   */
  merge(entries: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(entries)) {
      this.set(key, value)
    }
    return this
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Freeze
  // ───────────────────────────────────────────────────────────────────────────

  /** Lock the repository. After this, `set()` throws. */
  freeze(): void {
    this.frozen = true
  }

  /** Is the repository frozen? */
  isFrozen(): boolean {
    return this.frozen
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals — dotted-path walk
  // ───────────────────────────────────────────────────────────────────────────

  private read(key: string): unknown {
    const parts = key.split('.')
    let cur: unknown = this.data
    for (const part of parts) {
      if (cur === null || cur === undefined) return undefined
      if (typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[part]
    }
    return cur
  }

  private write(key: string, value: unknown): void {
    const parts = key.split('.')
    const last = parts.pop()
    if (last === undefined || last.length === 0) {
      throw new Error(`ConfigRepository: invalid key "${key}".`)
    }

    let cur = this.data as Record<string, unknown>
    for (const part of parts) {
      const next = cur[part]
      if (next === undefined || next === null || typeof next !== 'object') {
        const newSegment: Record<string, unknown> = {}
        cur[part] = newSegment
        cur = newSegment
      } else {
        cur = next as Record<string, unknown>
      }
    }
    cur[last] = value
  }
}

/** Deep clone preserving plain objects / arrays / primitives. */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(clone) as unknown as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = clone(v)
  }
  return out as T
}
