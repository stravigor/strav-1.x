# Mailables

A `Mailable<TPayload>` is a typed `Job` that builds and sends a `Message`. The class is the unit you ship — controllers dispatch it by class reference, not by composing a `Message` inline. Because `Mailable extends Job`, you get the queue's retry / backoff / abort / dead-letter for free, with no separate registry to maintain.

## Defining a Mailable

```ts
// app/Mail/welcome_email.ts
import { inject } from '@strav/kernel'
import { Mailable, type Message } from '@strav/mail'
import { MailManager } from '@strav/mail'
import { UserRepository } from '../Repositories/user_repository.ts'

@inject()
export class WelcomeEmail extends Mailable<{ userId: string }> {
  static override readonly jobName = 'mail.welcome'

  constructor(
    mail: MailManager,
    private readonly users: UserRepository,
  ) {
    super(mail)
  }

  async build({ userId }: { userId: string }): Promise<Message> {
    const user = await this.users.findOrFail(userId)
    return {
      to: { email: user.email, name: user.name },
      subject: `Welcome, ${user.name}`,
      html: `<p>Hi ${user.name} — welcome aboard.</p>`,
      text: `Hi ${user.name} — welcome aboard.`,
    }
  }
}
```

Three things to notice:

- **`@inject()` on the subclass even if you don't add deps.** The base class already declares it, but inheritance of `emitDecoratorMetadata` is brittle — redeclaring is the safest path and the cost is one line. Subclasses with extra deps redeclare anyway to register the new constructor signature.
- **`jobName` is a wire identifier.** `<package>.<verb>` or `<resource>.<verb>` is the convention. Changing it strands queue rows that reference the old name — treat it like a database column.
- **Payload is primitive ids, not models.** `{ userId: string }`, not `{ user: User }`. The Worker `JSON.stringify`s on dispatch and `JSON.parse`s on pickup; passing a full `User` snapshots stale state and bloats the queue row.

## Registering with the JobRegistry

Mailables register with the same `JobRegistry` the rest of your jobs use:

```ts
// bootstrap/jobs.ts
import { JobRegistry } from '@strav/queue'
import { WelcomeEmail } from '../app/Mail/welcome_email.ts'

export function registerJobs(registry: JobRegistry): void {
  registry.register(WelcomeEmail)
}
```

Or, if you keep mailables in a predictable folder, let the registry discover them:

```ts
await registry.discover('app/Mail/**/*.ts')
```

Auto-discovery picks up any `Job` (including `Mailable`) subclass with a `jobName` static.

## Dispatching

### Async (queued — the default path)

```ts
@inject()
class SignupController {
  constructor(private readonly queue: Queue) {}

  async signup(req: Request): Promise<Response> {
    const user = await createUser(req)
    await this.queue.dispatch(WelcomeEmail, { userId: user.id })
    return new Response(null, { status: 204 })
  }
}
```

The controller returns immediately; the Worker picks the job up, constructs `WelcomeEmail` through the container (so `UserRepository` resolves), calls `build()`, calls `MailManager.send()`. Network and provider latency stay off the request path.

Failures retry per the job's `maxAttempts` + `backoff`. The default is the standard `Job` policy.

### Sync (inline — for tight loops or local-dev)

`MailManager.send()` has an overload that takes the class:

```ts
@inject()
class AdminController {
  constructor(private readonly mail: MailManager) {}

  async resendWelcome(userId: string): Promise<void> {
    await this.mail.send(WelcomeEmail, { userId })
  }
}
```

This constructs the Mailable through the container (same DI path the Worker uses), builds, sends — all inside the calling request. No queue hop, no retries. Use it when:

- You're in a CLI command or one-off script where queue infrastructure is overkill.
- The caller already needs to wait for delivery (e.g. a synchronous "send-now" admin action that surfaces failures back to the operator).
- You're in a test and the queue is `array`-driven anyway — sync is simpler than draining the worker.

If you have a pre-built `Message`, the other `send` overload sends it directly:

```ts
await this.mail.send({ to: 'a@x', subject: '...', text: '...' })
```

## Routing through a non-default transport

The default `handle()` sends via the default transport. To route a Mailable through a named transport, override `handle`:

```ts
class BulkAnnouncement extends Mailable<{ batch: string[] }> {
  static override readonly jobName = 'mail.bulk-announce'

  async build({ batch }: { batch: string[] }): Promise<Message> {
    return { to: batch, subject: 'News', html: '<p>...</p>', text: '...' }
  }

  override async handle(ctx: JobContext<{ batch: string[] }>): Promise<void> {
    const message = await this.build(ctx.payload)
    await this.mail.via('bulk').send(message)
  }
}
```

Or, if every send of this kind should route the same way, set a constant in `build()` and ignore the routing question — but `via()` makes the intent explicit.

## Failure hook

Mailables inherit `Job.failed(ctx)`. Override it to react when retries are exhausted:

```ts
class WelcomeEmail extends Mailable<{ userId: string }> {
  static override readonly jobName = 'mail.welcome'
  static override readonly maxAttempts = 3

  async build({ userId }: { userId: string }): Promise<Message> { /* ... */ }

  override async failed(ctx: JobContext<{ userId: string }>): Promise<void> {
    // ctx.error carries the last thrown error — usually a MailTransportError.
    ctx.log.warn('welcome email failed permanently', {
      userId: ctx.payload.userId,
      error: ctx.error,
    })
    // Optionally flag the user so support follows up.
    await this.users.markEmailUndeliverable(ctx.payload.userId)
  }
}
```

`failed()` runs after `maxAttempts` retries; the job row lands in `strav_failed_jobs` with the final error captured. The hook itself runs inside the Worker, with `ctx.log` pre-bound to `jobId` + `jobName` + the failing attempt number.

For a `MailTransportError`, `ctx.error.context.provider` / `status` / `retryable` / `providerError` are the actionable fields — log them rather than the message string.

## Payload design

Keep payloads small and primitive:

- **Yes:** `{ userId: string, locale: string }` — the Mailable reads the fresh user from the repository on the worker side, so the email reflects current state at send time.
- **No:** `{ user: User }` — JSON round-trips strip class identity, and stale snapshots cause the "user changed their name between dispatch and send" bug.

Two exceptions worth knowing:

- **Idempotency tokens** belong in the payload. A `{ userId, sendId: string }` payload where `sendId` is a ULID lets `build()` short-circuit if you've already sent this exact email — useful when an upstream retried the request that triggered the dispatch.
- **Transient fields you can't refetch** (e.g. a one-time password you computed at dispatch time) belong in the payload too. There's no other place to put them.

## Mailable vs raw `mail.send()`

Use a Mailable when:

- The send needs to be retried, dead-lettered, or otherwise treated like background work.
- The same email is sent from multiple call sites — the Mailable centralises the `Message` build.
- The email has dependencies (`UserRepository`, an i18n service, etc.) that benefit from DI.

Use `mail.send(message)` directly when:

- The message is a one-off, fully described at the call site, and you're fine with the caller waiting.
- You're inside an admin action that surfaces failures back to the operator and a queue hop would hide them.

Both routes apply the same default `from`, hit the same transport, and report the same `MailTransportError` shape — the choice is about delivery semantics, not envelope handling.
