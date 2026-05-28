/**
 * `Job` — the unit of background work.
 *
 * Subclasses declare a stable `static jobName` (the wire identifier the
 * `JobRegistry` uses to route a serialized payload back to a class) and
 * implement `handle(ctx)`. The Worker constructs jobs through the
 * container so `@inject()`-marked subclasses get their dependencies
 * resolved the usual way; the payload arrives as JSON on the
 * `JobContext`.
 *
 * Configuration overrides (max attempts, backoff, timeout, queue name)
 * are static on the subclass. The Worker reads them per-attempt — see
 * the `JobConfig` interface below.
 *
 * ```ts
 * @inject()
 * class SendWelcomeEmail extends Job<{ userId: string }> {
 *   static override readonly jobName = 'mail.welcome'
 *
 *   constructor(
 *     private readonly users: UserRepository,
 *     private readonly mail: MailManager,
 *   ) {
 *     super()
 *   }
 *
 *   async handle(ctx: JobContext<{ userId: string }>): Promise<void> {
 *     const user = await this.users.findOrFail(ctx.payload.userId)
 *     await this.mail.send(new WelcomeEmail(user))
 *   }
 * }
 * ```
 */

import type { Logger } from '@strav/kernel'

/**
 * Per-invocation context passed to `Job.handle(ctx)`. Workers populate
 * every field — testing harnesses can build one by hand.
 */
export interface JobContext<TPayload = unknown> {
  /** Stable id assigned at dispatch (typically a ULID). */
  jobId: string
  /** 1-based attempt counter. `attempt === 1` is the first run. */
  attempt: number
  /** The deserialized payload. */
  payload: TPayload
  /**
   * Cancellation signal. Aborted when the Worker's shutdown grace
   * period elapses or the job exceeds its `timeout`. Handlers that
   * loop / stream should check `ctx.signal.aborted` and bail.
   */
  signal: AbortSignal
  /**
   * Job-scoped logger — prebound with `jobId` + `jobName` + `attempt`.
   * Standard Logger surface (`debug`/`info`/`warn`/`error`).
   */
  log: Logger
}

/**
 * Optional retry hook context — same shape as `JobContext` plus the
 * error that caused the failure.
 */
export interface JobFailedContext<TPayload = unknown> extends JobContext<TPayload> {
  /** The thrown value from the failed attempt. Already wrapped by the kernel error stack. */
  error: unknown
}

/**
 * The `static` config shape a Job subclass may set. Every field is
 * optional — the Worker falls back to driver defaults when omitted.
 */
export interface JobConfig {
  /** Total attempts (including the first). Default: driver-configured, typically 3. */
  maxAttempts?: number
  /**
   * Backoff in seconds for `attempt` (1-based). The Worker calls this
   * AFTER a failed attempt to schedule the next try. Default: exponential
   * with jitter (driver-configured).
   */
  backoff?(attempt: number): number
  /** Per-attempt time limit (seconds). Default: driver-configured. */
  timeout?: number
  /** Named queue to dispatch onto. Default: `'default'`. */
  queue?: string
}

/**
 * The abstract Job base class. Subclasses implement `handle` and set
 * `static jobName`. Other static fields are optional configuration —
 * see {@link JobConfig}.
 *
 * Generic parameter `TPayload` is the shape the dispatcher serializes
 * and the handler deserializes. Workers JSON.stringify/parse it
 * verbatim — keep it serializable (no Dates without a custom revival
 * step, no class instances).
 */
export abstract class Job<TPayload = unknown> {
  /**
   * Stable wire identifier mapping this class in the JobRegistry.
   * Subclasses MUST override. Convention: `<package>.<verb>` or
   * `<resource>.<verb>` (`mail.welcome`, `user.cleanup`).
   *
   * The base class declares an empty string so type-checking holds;
   * `JobRegistry.register()` rejects classes that didn't override.
   */
  static readonly jobName: string = ''

  // Optional static configuration. Declared on the base so subclasses
  // can shadow with `static override readonly <field> = <value>` under
  // `noImplicitOverride`. The Worker reads these per-attempt; omitted
  // fields fall back to driver defaults. Mirrors the {@link JobConfig}
  // interface — the interface drives `JobClass`'s typing, the static
  // fields here drive the override-friendly inheritance shape.
  static readonly maxAttempts?: number
  static readonly backoff?: (attempt: number) => number
  static readonly timeout?: number
  static readonly queue?: string

  /** The handler. Workers call this once they've constructed the job + built the context. */
  abstract handle(context: JobContext<TPayload>): Promise<void>

  /**
   * Optional failure hook. Fires when an attempt throws AND there are
   * still retries left; also fires once on the FINAL failure (so apps
   * can route to a dead-letter, post a Slack message, etc.). The Worker
   * runs this in a try/catch — a throw from `failed()` is logged but
   * doesn't change the retry decision.
   */
  failed?(context: JobFailedContext<TPayload>): Promise<void>
}

/**
 * Constructor reference for a Job subclass. The Worker / Queue store
 * these in the registry, look them up by `jobName`, and instantiate
 * via the container.
 */
export interface JobClass<TPayload = unknown> extends JobConfig {
  // biome-ignore lint/suspicious/noExplicitAny: ctor params are decided per-subclass; the @inject() flow resolves them.
  new (...args: any[]): Job<TPayload>
  readonly jobName: string
}

/**
 * Helper type: extract the payload type from a `JobClass`.
 *
 * ```ts
 * type WelcomePayload = PayloadOf<typeof SendWelcomeEmail>
 * // → { userId: string }
 * ```
 */
export type PayloadOf<T> = T extends JobClass<infer P> ? P : never
