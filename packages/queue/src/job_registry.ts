/**
 * `JobRegistry` — runtime catalog of every registered `Job` class.
 *
 * Apps register jobs explicitly (`register(JobClass)` / `registerAll
 * ([...])`) or via `discover(pattern)`, which uses `Bun.Glob` to scan
 * files + dynamically `import()` each, registering every exported
 * class that satisfies {@link isJobClass}. Same shape as
 * `SchemaRegistry.discover` in `@strav/database`.
 *
 * The registry rejects two different classes claiming the same
 * `jobName` (a wire-protocol collision — the Worker can't disambiguate
 * which class to instantiate). Re-imports of the same class via a
 * barrel are deduped by identity.
 */

import { ConfigError } from '@strav/kernel'
import { Job, type JobClass } from './job.ts'

export class JobRegistry {
  private readonly byName = new Map<string, JobClass>()

  /** Register one Job class. Throws when `jobName` is empty or already taken. */
  register(jobClass: JobClass): this {
    if (!jobClass.jobName) {
      throw new ConfigError(
        `JobRegistry: ${jobClass.name || 'anonymous job'} must declare a non-empty \`static jobName\` — that's the wire identifier the Worker dispatches against.`,
      )
    }
    const existing = this.byName.get(jobClass.jobName)
    if (existing === jobClass) return this
    if (existing) {
      throw new ConfigError(
        `JobRegistry: jobName "${jobClass.jobName}" is already registered to a different class (${existing.name} vs ${jobClass.name}). Pick a different jobName — the Worker uses it to route serialized payloads back to a class.`,
      )
    }
    this.byName.set(jobClass.jobName, jobClass)
    return this
  }

  /** Register several. Order matters only insofar as register() throws on conflict. */
  registerAll(jobClasses: readonly JobClass[]): this {
    for (const cls of jobClasses) this.register(cls)
    return this
  }

  /**
   * Auto-discover Job classes by glob pattern. For each matched file:
   *   1. dynamically `import()` it,
   *   2. iterate every exported value,
   *   3. register every one that satisfies {@link isJobClass}.
   *
   * `pattern` is a `Bun.Glob`-compatible string (or array). `cwd`
   * defaults to `process.cwd()` (typically the repo root). Returns
   * `this` for chaining.
   *
   * Re-exports of the same class via multiple files dedupe by object
   * identity — typical barrel patterns work. Two DIFFERENT classes
   * sharing a `jobName` still throw `ConfigError`.
   *
   * Files exporting no Job classes (helpers, type-only re-exports) are
   * silently skipped.
   */
  async discover(pattern: string | string[], options: { cwd?: string } = {}): Promise<this> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    const cwd = options.cwd ?? process.cwd()
    const files = new Set<string>()
    for (const p of patterns) {
      const glob = new Bun.Glob(p)
      for await (const file of glob.scan({ cwd, absolute: true })) {
        files.add(file)
      }
    }
    for (const file of files) {
      const mod = (await import(file)) as Record<string, unknown>
      for (const value of Object.values(mod)) {
        if (!isJobClass(value)) continue
        this.register(value)
      }
    }
    return this
  }

  /** Resolve by `jobName`. Returns `undefined` for unknown names. */
  get(jobName: string): JobClass | undefined {
    return this.byName.get(jobName)
  }

  /** Throwing variant — use when "this job must exist" is a hard precondition. */
  getOrFail(jobName: string): JobClass {
    const cls = this.byName.get(jobName)
    if (!cls) {
      throw new ConfigError(
        `JobRegistry: no Job is registered under "${jobName}". ` +
          'Either the dispatcher serialized an unknown class, or the Worker is running against a different registry than the dispatcher used.',
      )
    }
    return cls
  }

  /** True when a Job with this `jobName` is registered. */
  has(jobName: string): boolean {
    return this.byName.has(jobName)
  }

  /** Every registered class, in insertion order. */
  all(): readonly JobClass[] {
    return [...this.byName.values()]
  }

  /** Test helper: wipe the registry. */
  clear(): void {
    this.byName.clear()
  }
}

/**
 * Type-guard: a value looks like a Job class — a function whose
 * prototype extends `Job` and which declares a non-empty `jobName`.
 * Used by `discover()` to filter exported values; exported so apps can
 * hand-roll their own discovery loops.
 *
 * The prototype check is conservative — a class that doesn't extend
 * `Job` (even one that happens to look duck-typed) is rejected. That's
 * intentional: the `failed?` hook + future Worker extensions key off
 * `instanceof Job`, so the registry's identity guarantee has to match.
 */
export function isJobClass(value: unknown): value is JobClass {
  if (typeof value !== 'function') return false
  // The Job constructor itself isn't registerable (it's abstract); only
  // subclasses are.
  if (value === Job) return false
  if (!(value.prototype instanceof Job)) return false
  const jobName = (value as { jobName?: unknown }).jobName
  return typeof jobName === 'string' && jobName.length > 0
}
