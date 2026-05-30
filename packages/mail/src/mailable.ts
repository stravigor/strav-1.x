/**
 * `Mailable<TPayload>` — a typed `Job` that builds and sends a mail
 * message.
 *
 * Apps subclass `Mailable`, set `static override jobName`, and implement
 * `build(payload)` to produce a `Message`. The framework provides
 * `handle()` — it calls `build(ctx.payload)` and forwards the result to
 * `MailManager.send(message)`.
 *
 * Because `Mailable extends Job`, mailables participate in the full job
 * lifecycle: retries, backoff, abort-aware shutdown, `failed()` hook,
 * dead-letter via `strav_failed_jobs`. There is no separate
 * `MailableRegistry` — mailables register with the same `JobRegistry`
 * the rest of the app uses, and dispatch the same way:
 *
 *     await queue.dispatch(WelcomeEmail, { userId: '01J...' })
 *
 * For sync sends inside a request (no queue hop), apps call either
 * `MailManager.send(WelcomeEmail, payload)` (the overload constructs
 * the Mailable via the container, builds, sends) or — if the message
 * is already built — `MailManager.send(message)` directly.
 *
 * Dependency injection
 *   The base class declares `@inject()` and a constructor taking
 *   `MailManager`. Subclasses without additional deps inherit both
 *   shape and metadata — `container.make(WelcomeEmail)` resolves
 *   `MailManager` via the inherited `@inject()` reflection.
 *
 *   Subclasses with extra deps redeclare:
 *
 *     @inject()
 *     class WelcomeEmail extends Mailable<{ userId: string }> {
 *       static override readonly jobName = 'mail.welcome'
 *       constructor(
 *         mail: MailManager,
 *         private readonly users: UserRepository,
 *       ) { super(mail) }
 *       async build({ userId }) {
 *         const user = await this.users.findOrFail(userId)
 *         return { to: user.email, subject: 'Welcome', text: `Hi ${user.name}` }
 *       }
 *     }
 *
 * Payload shape
 *   `TPayload` must round-trip through JSON — same constraint as any
 *   `Job` payload. The Worker `JSON.stringify`s on dispatch and
 *   `JSON.parse`s on pick-up; non-serialisable values silently corrupt.
 */

import { inject } from '@strav/kernel'
import { Job, type JobContext } from '@strav/queue'
// Value import required — `@inject()` reads constructor paramtypes via
// `emitDecoratorMetadata`, which erases `import type` references to
// `Object`. Container then can't resolve them. This is one-way:
// `mail_manager.ts` imports types from this file only, so there's no
// runtime cycle. Biome's useImportType lint suggests the wrong fix.
// biome-ignore lint/style/useImportType: value import is load-bearing for @inject() metadata emission
import { MailManager } from './mail_manager.ts'
import type { Message } from './message.ts'

@inject()
export abstract class Mailable<TPayload = unknown> extends Job<TPayload> {
  constructor(protected readonly mail: MailManager) {
    super()
  }

  /**
   * Construct the `Message` to send. Called once per attempt. Receives
   * the dispatched payload (JSON-deserialized when running under a
   * persistent queue driver).
   *
   * May read async resources — the `Job` lifecycle awaits it. Throwing
   * triggers the standard retry path; consider whether the thrown
   * condition is transient (give up after `maxAttempts`) or permanent
   * (override `maxAttempts = 1` so it dead-letters immediately).
   */
  abstract build(payload: TPayload): Message | Promise<Message>

  /**
   * Default handler — builds the message, sends it through the default
   * transport. Subclasses can override (e.g. to route through a named
   * transport via `this.mail.via('priority').send(message)`), but the
   * default covers the common case.
   */
  override async handle(context: JobContext<TPayload>): Promise<void> {
    const message = await this.build(context.payload)
    await this.mail.send(message)
  }
}

/**
 * Constructor-shape for any `Mailable` subclass — used by
 * `MailManager.send(MailableClass, payload)` typing. Mirrors
 * `JobClass` from `@strav/queue` but constrained to `Mailable`.
 */
export interface MailableClass<TPayload = unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: matches kernel `Constructor<T>` variance — subclasses have arbitrary constructor params
  new (...args: any[]): Mailable<TPayload>
  readonly jobName: string
}

/**
 * Extract the payload type from a `MailableClass` reference. Useful for
 * typed wrappers that take a `MailableClass` and need to type their
 * `payload` parameter against it.
 */
export type MailablePayloadOf<T> = T extends MailableClass<infer P> ? P : never
