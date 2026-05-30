# `@strav/notification` API

The public exports + their semantics. Pairs with the [README](./README.md) overview.

## Root barrel — `@strav/notification`

### `class NotificationManager`

Facade. Apps resolve via `app.resolve(NotificationManager)`.

```ts
class NotificationManager {
  constructor(options: NotificationManagerOptions)

  /** Resolve a channel driver. */
  use(name?: string): NotificationDriver

  /** Register a channel factory. Adapter packages call from their ServiceProvider's boot. */
  extend(driverName: string, factory: NotificationDriverFactory): void

  /** Hand-wire a channel instance (tests / one-offs). */
  useDriver(instanceName: string, driver: NotificationDriver): void

  /** Fan-out: routes through every channel `notification.via(notifiable)` returns. */
  send(
    notifiable: Notifiable,
    notification: BaseNotification,
  ): Promise<NotificationDispatchResult>
}
```

`send()` collects per-channel results into `NotificationDispatchResult.deliveries[]`. Channel-level throws are captured (`delivered: false`, `error: ...`) — `send()` never rethrows.

### `abstract class BaseNotification`

Apps subclass per notification type.

```ts
abstract class BaseNotification {
  abstract via(notifiable: Notifiable): readonly string[]
}
```

Apps add per-channel hooks (`toMail`, `toDatabase`, `toLog`, …) as optional methods on the subclass — each channel reads the matching hook at dispatch time.

### `interface Notifiable`

```ts
interface Notifiable {
  readonly id: string | number
  readonly notifiableType?: string
  [key: string]: unknown   // channel-specific fields (email, phone, preferences, …)
}
```

### `class NotificationProvider extends ServiceProvider`

Wires the manager into the container. Registers `name: 'notification'` so channel adapter providers can declare `dependencies: ['notification']`.

### `interface NotificationDriver`

```ts
interface NotificationDriver {
  readonly name: string
  send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult>
}
```

### `type NotificationDriverFactory`

```ts
type NotificationDriverFactory = (args: {
  instanceName: string
  config: { driver: string; [key: string]: unknown }
}) => NotificationDriver
```

### Types

```ts
interface NotificationContext { id: string; dispatchedAt: Date; idempotencyKey?: string }
interface NotificationDeliveryResult {
  channel: string
  delivered: boolean
  reference?: string
  error?: Error
}
interface NotificationDispatchResult { id: string; deliveries: readonly NotificationDeliveryResult[] }
```

### Errors

- `NotificationError` (base)
- `NotificationConfigError` — `config.notification` missing or default channel unknown
- `UnknownChannelError` — name not in `channels`, or driver factory not registered
- `NotificationDeliveryError` — channel-side failure (preserves upstream in `.cause`)

### Test double — `MockNotificationDriver`

```ts
class MockNotificationDriver implements NotificationDriver {
  readonly records: MockNotificationRecord[]
  constructor(name?: string)
  clear(): void
}
```

`mockNotificationDriverFactory` is the matching factory — register with `manager.extend('mock', factory)` or use directly via `manager.useDriver(name, new MockNotificationDriver())`.

## `@strav/notification/mail`

```ts
class MailNotificationDriver implements NotificationDriver
class MailNotificationProvider extends ServiceProvider  // declares 'notification.mail', deps ['notification', 'mail']
type MailChannelConfig = { driver: 'mail'; transport?: string }
```

Reads `notification.toMail(notifiable): Message | Promise<Message>` and dispatches via `MailManager.send`.

## `@strav/notification/database`

```ts
class DatabaseNotificationDriver implements NotificationDriver
class DatabaseNotificationProvider extends ServiceProvider  // declares 'notification.database', deps ['notification', 'database']

class NotificationRepository extends Repository<NotificationRecord> {
  async record(input: RecordInput): Promise<NotificationRecord>
  async unread(notifiable: Notifiable): Promise<NotificationRecord[]>
  async markAsRead(id: string): Promise<NotificationRecord | undefined>
}

class NotificationRecord extends Model  // id, notifiable_id, notifiable_type, type, data, read_at, created_at, updated_at

const notificationSchema  // non-tenanted; for tenanted variant see @strav/notification/tenanted

function applyNotificationMigration(db, { registry }): Promise<void>
```

Reads `notification.toDatabase(notifiable): Record<string, unknown>` and persists a row.

## `@strav/notification/log`

```ts
class LogNotificationDriver implements NotificationDriver
class LogNotificationProvider extends ServiceProvider  // declares 'notification.log', deps ['notification', 'logger']
type LogChannelConfig = { driver: 'log'; level?: 'info' | 'warn' | 'error' }
```

Reads `notification.toLog(notifiable): string | Record<string, unknown>` and logs to the kernel `Logger`. Falls back to `"<ClassName> dispatched to <channel>"` when no hook.

## `@strav/notification/webhook`

```ts
class WebhookNotificationDriver implements NotificationDriver
class WebhookNotificationProvider extends ServiceProvider  // declares 'notification.webhook', deps ['notification']

type WebhookChannelConfig = {
  driver: 'webhook'
  endpoint: string                                // POST URL
  secret: string                                  // HMAC key
  algorithm?: 'sha256' | 'sha1' | 'sha512'        // default 'sha256'
  headers?: Record<string, string>                // merged with built-ins (built-ins win)
  timeoutMs?: number                              // default 5000
}

function signWebhook(
  algorithm: 'sha256' | 'sha1' | 'sha512',
  secret: string,
  timestamp: string,
  body: string,
): string

function verifyWebhookSignature(
  algorithm: 'sha256' | 'sha1' | 'sha512',
  secret: string,
  timestamp: string,
  body: string,
  receivedSignatureHex: string,
): boolean
```

Reads `notification.toWebhook(notifiable): unknown | Promise<unknown>` and POSTs a signed JSON envelope. The envelope shape:

```jsonc
{
  "notification": {
    "id": "01J...",                       // matches NotificationContext.id
    "type": "InvoicePaid",                // notification subclass name
    "dispatchedAt": "2026-05-30T08:30:00.000Z"
  },
  "notifiable": { "id": "u_1", "type": "User" },  // `type` omitted if notifiable.notifiableType is absent
  "data":       { /* whatever toWebhook returned */ }
}
```

Outbound headers (built-ins) — configured `headers` are merged first, then these overwrite:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-strav-notification-id` | `NotificationContext.id` (ULID) |
| `x-strav-notification-type` | notification subclass name |
| `x-strav-timestamp` | unix seconds at send time |
| `x-strav-signature` | `${algorithm}=${hex}` over `${timestamp}.${body}` |

**Receiver verification:**

```ts
import { verifyWebhookSignature } from '@strav/notification/webhook'

const sigHeader = req.headers['x-strav-signature'] ?? ''
const [algo, sig] = sigHeader.split('=')
const ts = req.headers['x-strav-timestamp'] ?? ''

if (!verifyWebhookSignature(algo as 'sha256', SECRET, ts, rawBody, sig)) {
  return new Response(null, { status: 401 })
}
if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) {
  return new Response(null, { status: 401 })   // replay window
}
```

**Errors.** Skips delivery (`{ delivered: false }`, no throw) when `toWebhook` is absent — same opt-out semantics as the mail driver. Throws `NotificationDeliveryError` on:

- Non-2xx response: `context.status` carries the upstream status, `context.retryable` is `true` for 5xx / 408 / 429, the first 1KB of the response body lives under `context.responseBody`.
- Network failure / timeout: `context.retryable = true`, original error preserved as `cause`.

## `@strav/notification/broadcast`

```ts
class BroadcastNotificationDriver implements NotificationDriver
class BroadcastNotificationProvider extends ServiceProvider  // declares 'notification.broadcast', deps ['notification', 'broadcast']

interface BroadcastNotificationPayload {
  channel: string                          // target pub/sub channel
  event?: string                           // default: notification subclass name
  data: unknown                            // JSON-serialisable
}

type BroadcastChannelConfig = { driver: 'broadcast' }   // no provider-specific knobs
```

Reads `notification.toBroadcast(notifiable): BroadcastNotificationPayload | Promise<BroadcastNotificationPayload>` and calls `Broadcaster.publish(channel, { id, event, data })` with `id = NotificationContext.id` so SSE clients can match the broadcast event to the dispatch record (e.g. for de-duplication when the same notification was also recorded to the database).

Skips delivery (`{ delivered: false }`, no throw) when `toBroadcast` is absent — same opt-out semantics as the mail / webhook drivers. Throws `NotificationDeliveryError` if the hook throws or the underlying `Broadcaster.publish` fails. The broadcast `channel` lands under `context.broadcastChannel` so the failure record points at the right pub/sub destination.

Apps wiring this driver register `BroadcastProvider` (or `PostgresBroadcastProvider`) from `@strav/broadcast` BEFORE `BroadcastNotificationProvider` so the `Broadcaster` token is bound when the channel factory is resolved.

## `@strav/notification/discord`

```ts
class DiscordNotificationDriver implements NotificationDriver
class DiscordNotificationProvider extends ServiceProvider  // declares 'notification.discord', deps ['notification']

interface DiscordMessage {
  content?: string
  username?: string                                  // overrides channel default
  avatarUrl?: string                                 // overrides channel default
  embeds?: ReadonlyArray<Record<string, unknown>>
  components?: ReadonlyArray<Record<string, unknown>>
  allowedMentions?: Record<string, unknown>
  tts?: boolean
  threadName?: string                                // forum channels only
  flags?: number
  webhookUrl?: string                                // overrides notifiable + channel URL
  extra?: Record<string, unknown>                    // verbatim merge — for fields the envelope hasn't grown to yet
}

interface DiscordChannelConfig extends ChannelConfig {
  driver: 'discord'
  webhookUrl?: string                                // default URL; optional
  username?: string                                  // default identity
  avatarUrl?: string
  wait?: boolean                                     // append `?wait=true` so Discord echoes the created message JSON
  timeoutMs?: number                                 // default 5000
}
```

POSTs `notification.toDiscord(notifiable, defaults)` to Discord's
[Execute Webhook](https://discord.com/developers/docs/resources/webhook#execute-webhook) endpoint. The hook returns either a `string` (shorthand for `{ content }`) or a full `DiscordMessage`. Camel-case envelope keys are mapped to Discord's snake_case wire form on send (`avatarUrl` → `avatar_url`, `allowedMentions` → `allowed_mentions`, `threadName` → `thread_name`); the `extra` field spreads verbatim for schema fields the typed envelope hasn't grown to yet.

**Webhook URL resolution** — `message.webhookUrl` > `notifiable.discordWebhookUrl` > `config.webhookUrl`. When none resolve, the driver returns `{ delivered: false }` without throwing — same opt-out semantics as mail / webhook. The channel default is therefore optional: apps that route every dispatch via per-recipient or per-message URLs leave `config.webhookUrl` unset.

**Reference field** — with `wait: false` (the default) Discord returns 204; the dispatch result's `reference` falls back to the notification context id. With `wait: true` the driver waits for the 200 response, parses the created message JSON, and surfaces its `id` as the reference for downstream correlation.

**Retry signalling** — `429` (rate limit) and `5xx` flag `context.retryable = true`; `4xx` are non-retryable. Network failures wrap as retryable. Response bodies are truncated to 1KB in error context to avoid bloated logs.

No external deps — pure `fetch`. Apps wiring this driver register `DiscordNotificationProvider` after `NotificationProvider`.

## `@strav/notification/sse`

```ts
class SSENotificationDriver implements NotificationDriver {
  subscribe(id: string | number, opts?: SSESubscribeOptions): AsyncIterable<SSEEvent>
  subscriberCount(id: string | number, opts?: SSESubscribeOptions): number
  send(notifiable, notification, context): Promise<NotificationDeliveryResult>
}
class SSENotificationProvider extends ServiceProvider  // declares 'notification.sse', deps ['notification']

interface SSESubscribeOptions {
  notifiableType?: string                   // routing key is `${type ?? ''}|${id}`
}

interface SSEChannelConfig extends ChannelConfig {
  driver: 'sse'
  queueSize?: number                        // per-subscriber bounded queue; default 64
}
```

In-process pub/sub for live browser delivery. Distinct from the broadcast channel: SSE has **no peer infrastructure** (no `Broadcaster`, no Postgres LISTEN/NOTIFY) — one process, one registry. Apps that need cross-process fan-out use `./broadcast`; apps that just want the recipient to see the notification in their open tab use this.

Reads `notification.toSSE(notifiable): SSEEvent | string`. The driver auto-fills `id` (from `NotificationContext.id`) and `event` (from the notification's class name) when the hook omits them — both can be overridden.

**Subscriber lifecycle.** HTTP handlers open a subscription with `driver.subscribe(id, { notifiableType? })` and pipe the iterable into `sseResponse(...)` from `@strav/http`. When the iterator's `return()` runs (client disconnect or break in `for await`), the subscriber is detached from the registry and the slot freed.

```ts
router.get('/notifications/stream', async (ctx) => {
  const user = ctx.auth.user!
  const sse = notifications.use('sse') as SSENotificationDriver
  const stream = sse.subscribe(user.id, { notifiableType: 'User' })
  return sseResponse(stream, { signal: ctx.request.raw.signal })
})
```

**Backpressure.** Each subscriber holds a bounded queue (default 64). When a slow consumer falls behind, the oldest events are dropped (and `Subscriber.droppedEvents` increments). Lost events are the SSE contract anyway — clients reconnect with `Last-Event-ID` and apps backfill from the database channel.

**Dispatch outcomes.** `delivered: true` when ≥ 1 subscriber received the event; `delivered: false` (no error) when the hook is absent OR no subscribers exist for the notifiable. Apps inspect `result.delivered === false && result.error === undefined` to branch on "user is offline".

Peer-optional on `@strav/http` (only the `SSEEvent` type at the type level). No runtime peer.

## `@strav/notification/tenanted`

```ts
class TenantedNotificationRepository extends Repository<TenantedNotificationRecord>
class TenantedNotificationRecord extends Model
const tenantedNotificationSchema  // same shape + tenant_id FK + RLS policy
function applyTenantedNotificationMigration(db, { registry }): Promise<void>
```

Apps wire `TenantedNotificationRepository` themselves and pass it to `new DatabaseNotificationDriver({ name, repository })` — same pattern as `@strav/social/tenanted`.
