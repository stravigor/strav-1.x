# Custom channels

The `NotificationDriver` contract is two methods and one property. Apps register custom drivers via `manager.extend(driverName, factory)` from a ServiceProvider — same pattern every shipped channel uses. This guide walks through building one end-to-end against a hypothetical Slack channel.

## The contract

```ts
interface NotificationDriver {
  readonly name: string
  send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult>
}

interface NotificationDeliveryResult {
  channel: string                                 // matches the registered channel name
  delivered: boolean
  reference?: string                              // provider-side id when applicable
  error?: Error                                   // — see "Error handling" below
}

type NotificationDriverFactory = (args: {
  instanceName: string
  config: { driver: string; [key: string]: unknown }
}) => NotificationDriver
```

That's it. No required base class, no per-channel hook signature the driver must observe (each driver invents its own — `toMail`, `toDatabase`, etc.). The factory builds the driver instance lazily on first `manager.use(channelName)` and the result is cached for the lifetime of the manager.

## Building one — Slack

Slack ships incoming webhooks. Each app or workspace generates a URL; you POST a JSON body and Slack relays it to the configured channel. Good first custom driver because it's small and the failure modes are familiar (HTTP).

### Driver

```ts
// app/Notifications/Slack/slack_notification_driver.ts
import type {
  BaseNotification,
  Notifiable,
  NotificationContext,
  NotificationDeliveryResult,
  NotificationDriver,
} from '@strav/notification'
import { NotificationDeliveryError } from '@strav/notification'

// Optional hook surface — apps add `toSlack(notifiable)` on their notification.
interface SlackCapableNotification extends BaseNotification {
  toSlack?(notifiable: Notifiable): SlackPayload | Promise<SlackPayload>
}

export interface SlackPayload {
  text?: string                                   // fallback for clients without block support
  blocks?: unknown[]                              // Slack Block Kit blocks
  username?: string
  icon_emoji?: string
}

export interface SlackNotificationDriverOptions {
  name: string
  webhookUrl: string
  fetch?: typeof fetch                            // override for tests
  timeoutMs?: number                              // default 5000
}

export class SlackNotificationDriver implements NotificationDriver {
  readonly name: string
  private readonly webhookUrl: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(options: SlackNotificationDriverOptions) {
    this.name = options.name
    this.webhookUrl = options.webhookUrl
    this.fetchFn = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  async send(
    notifiable: Notifiable,
    notification: BaseNotification,
    context: NotificationContext,
  ): Promise<NotificationDeliveryResult> {
    const hook = (notification as SlackCapableNotification).toSlack
    if (typeof hook !== 'function') {
      return { channel: this.name, delivered: false }
    }

    const payload = await hook.call(notification, notifiable)

    let response: Response
    try {
      response = await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new NotificationDeliveryError(
        `SlackNotificationDriver: network failure for channel "${this.name}".`,
        {
          context: {
            channel: this.name,
            notifiableId: notifiable.id,
            notification: notification.constructor.name,
            retryable: true,
          },
          cause,
        },
      )
    }

    if (response.ok) {
      return { channel: this.name, delivered: true, reference: context.id }
    }

    const body = await response.text().catch(() => '')
    throw new NotificationDeliveryError(
      `SlackNotificationDriver: webhook responded HTTP ${response.status}.`,
      {
        context: {
          channel: this.name,
          notifiableId: notifiable.id,
          notification: notification.constructor.name,
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
          responseBody: body.slice(0, 1024),
        },
      },
    )
  }
}
```

Three patterns worth pointing out:

1. **Optional hook.** `toSlack` is detected via the `SlackCapableNotification` interface — if a notification doesn't implement it, return `{ delivered: false }` without throwing. Matches the rest of the framework: a channel that the notification doesn't support is a no-op, not an error.
2. **`reference: context.id`** — the dispatch ULID lands on the result so logs / persistence rows align. Some drivers also extract a provider-side reference (Slack's response includes a `ts` timestamp you could use); prefer the dispatch ULID when there's no semantic loss, so callers can match against the database row.
3. **`AbortSignal.timeout(this.timeoutMs)`** — bound the request so a hung Slack endpoint doesn't stall the dispatch. The standard pattern across every HTTP driver in the framework.

### Config + factory

```ts
// app/Notifications/Slack/slack_channel_config.ts
import type { ChannelConfig } from '@strav/notification'

export interface SlackChannelConfig extends ChannelConfig {
  driver: 'slack'
  webhookUrl: string
  timeoutMs?: number
}
```

```ts
// app/Notifications/Slack/slack_notification_provider.ts
import { type Application, ServiceProvider } from '@strav/kernel'
import { NotificationConfigError, NotificationManager } from '@strav/notification'
import { SlackNotificationDriver } from './slack_notification_driver.ts'
import type { SlackChannelConfig } from './slack_channel_config.ts'

export class SlackNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.slack'
  override readonly dependencies = ['notification']

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    manager.extend('slack', ({ instanceName, config }) => {
      const cfg = config as SlackChannelConfig
      if (!cfg.webhookUrl) {
        throw new NotificationConfigError(
          `SlackNotificationProvider: channel "${instanceName}" requires \`webhookUrl\`.`,
          { context: { channel: instanceName } },
        )
      }
      return new SlackNotificationDriver({
        name: instanceName,
        webhookUrl: cfg.webhookUrl,
        ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      })
    })
  }
}
```

The provider's `boot` reads the manager, registers the factory, and exits. The factory itself isn't invoked at boot — it runs the first time something resolves a channel with `driver: 'slack'`. That keeps boot fast: an app configuring six channels doesn't construct six HTTP clients at startup.

`dependencies: ['notification']` ensures `NotificationProvider` ran first so `manager.extend(...)` resolves a real manager. Any other dependencies (e.g. an HTTP client wrapper) go in the same list and are resolved via `app.resolve(...)` inside `boot`.

### Wiring + config

```ts
// bootstrap/providers.ts
import { SlackNotificationProvider } from '../app/Notifications/Slack/slack_notification_provider.ts'

export default [
  // ... ConfigProvider, LoggerProvider, NotificationProvider, …
  new SlackNotificationProvider(),
]
```

```ts
// config/notification.ts
export default {
  channels: {
    mail:      { driver: 'mail' },
    database:  { driver: 'database' },
    slack_alerts: {
      driver: 'slack',
      webhookUrl: process.env.SLACK_ALERTS_WEBHOOK ?? '',
    },
  },
} satisfies NotificationConfig
```

The channel name (`slack_alerts`) is what notifications refer to in `via()`. You can register the same driver multiple times under different channel names for multi-workspace fanouts.

### Notification

```ts
class DeployFailed extends BaseNotification {
  constructor(private readonly payload: { service: string; commit: string; reason: string }) {
    super()
  }
  override via(): readonly string[] {
    return ['database', 'slack_alerts']
  }
  toDatabase(_n: Notifiable) { return this.payload }
  toSlack(_n: Notifiable): SlackPayload {
    return {
      text: `🚨 ${this.payload.service} deploy failed: ${this.payload.reason}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🚨 Deploy failed' } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Service:*\n${this.payload.service}` },
          { type: 'mrkdwn', text: `*Commit:*\n\`${this.payload.commit.slice(0, 8)}\`` },
        ]},
      ],
    }
  }
}
```

## Error handling

The manager captures `error` and reports `delivered: false`. Two conventions are worth keeping:

- **`NotificationDeliveryError`** (status 502, code `notification.delivery`) — the typed error every channel throws on driver-side failure. `context.retryable` is a hint for downstream retry policy. Other channels in the same fan-out continue regardless.
- **Don't capture-and-swallow inside the driver.** The manager's job is the capture; the driver's job is to throw clearly. If you swallow internally and return `{ delivered: false, error: …}` instead, you'll break the assertion that "`error: undefined` means no hook" — which is what application code branches on to decide between "channel not supported" and "channel failed".

## Where to put the code

Conventionally, custom channels live in `app/Notifications/<channel>/`. The framework's shipped channels live under `packages/notification/src/drivers/<channel>/` because they're cross-cutting; an app-specific channel goes inside the app. If the channel is truly reusable (you're building an SDK or sharing it across services), publish it as `@your-org/notification-slack` and import it like any other adapter package.

The dependency direction is:

```
your-app → @your-org/notification-slack → @strav/notification (manager + driver contract)
```

The adapter package never imports from your app; the app's providers list pulls the adapter's provider.

## Tests

`MockNotificationDriver` is for asserting on the fan-out from the *notification* side ("did the notification dispatch to channel X with payload Y?"). For testing the *driver* itself ("when Slack returns 500, does the driver throw NotificationDeliveryError flagged retryable?"), stub `fetch` and exercise the driver directly:

```ts
import { test, expect } from 'bun:test'
import { SlackNotificationDriver } from './slack_notification_driver.ts'
import { NotificationDeliveryError } from '@strav/notification'

test('flags 5xx as retryable', async () => {
  const driver = new SlackNotificationDriver({
    name: 'slack_alerts',
    webhookUrl: 'https://hooks.slack.example/services/x/y/z',
    fetch: async () => new Response('overloaded', { status: 503 }),
  })

  class Test extends BaseNotification {
    override via() { return ['slack_alerts'] }
    toSlack() { return { text: 'hi' } }
  }

  let caught: unknown
  try {
    await driver.send(
      { id: 'u_1' },
      new Test(),
      { id: 'n_1', dispatchedAt: new Date() },
    )
  } catch (err) { caught = err }

  expect(caught).toBeInstanceOf(NotificationDeliveryError)
  expect((caught as NotificationDeliveryError).context['retryable']).toBe(true)
})
```

The shipped drivers' test files (`packages/notification/tests/drivers/*/`) are the canonical reference for the pattern — copy their `makeFetchStub` helper and adapt.

## When NOT to write a custom driver

The framework's job is fan-out across multiple delivery surfaces. If your "channel" is:

- **A one-off integration with no `to<Channel>` hook story** — i.e., every dispatch through it would carry the same payload regardless of notification — you're better off injecting your HTTP client directly into a service and skipping the channel abstraction entirely.
- **Just another webhook with a different URL** — register a second `webhook` channel in config (`webhook_billing` / `webhook_analytics`). Same driver, different config. No new code.
- **A queue dispatch** — fire jobs from inside `BaseNotification.via()` or a wrapping service, not via a custom driver. Notifications are about user-facing event fan-out, not background work routing.

Reach for a custom driver when there's a meaningful per-notification hook (`toSlack` carries Block Kit while `toMail` carries an HTML body), the channel has its own failure semantics worth surfacing through `NotificationDeliveryError`, and the same driver instance gets reused across notification types.
