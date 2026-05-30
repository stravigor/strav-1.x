# Testing notifications

The framework ships `MockNotificationDriver` for asserting fan-out without standing up real channels. For unit-level tests you swap channels for mocks; for integration tests you wire the real channels and inspect their state (`ArrayTransport.messages` for mail, the database row for the database channel, etc.).

## MockNotificationDriver

Replaces any channel — records every dispatch in an array, reports `delivered: true` with the dispatch ULID as `reference`. Two ways to wire it.

### Per-test swap

After `bootTestApp` returns, swap a channel's driver via `manager.useDriver(name, instance)`:

```ts
import { MockNotificationDriver } from '@strav/notification'
import { test, expect } from 'bun:test'

test('signup fan-outs WelcomeEmail to mail + database channels', async () => {
  const { app, signup } = await bootTestApp()
  const manager = app.resolve(NotificationManager)

  const mail = new MockNotificationDriver('mail')
  const database = new MockNotificationDriver('database')
  manager.useDriver('mail', mail)
  manager.useDriver('database', database)

  await signup({ email: 'alice@example.com', name: 'Alice' })

  expect(mail.records).toHaveLength(1)
  expect(database.records).toHaveLength(1)
  expect(mail.records[0]?.notification.constructor.name).toBe('WelcomeEmail')
  expect(mail.records[0]?.notifiable.id).toBe('u_alice')
})
```

`useDriver` overrides any cached instance for that channel name, so subsequent `manager.use(...)` calls and `manager.send(...)` fan-outs hit the mock. Per-test swap is clean — every test owns its own mock instance, no leakage.

### Config-driven

Register `mockNotificationDriverFactory` against the `'mock'` driver discriminator and use `{ driver: 'mock' }` in test config:

```ts
// bootstrap/providers.test.ts
import { mockNotificationDriverFactory, NotificationManager } from '@strav/notification'

class MockChannelsProvider extends ServiceProvider {
  override readonly name = 'notification.mock'
  override readonly dependencies = ['notification']
  override async boot(app: Application): Promise<void> {
    app.resolve(NotificationManager).extend('mock', mockNotificationDriverFactory)
  }
}
```

```ts
// config/notification.ts (test mode)
export default {
  channels: {
    mail:     { driver: 'mock' },
    database: { driver: 'mock' },
  },
} satisfies NotificationConfig
```

Now every channel in the test build is a mock. Read them via `manager.use('mail') as MockNotificationDriver`:

```ts
const mail = manager.use('mail') as MockNotificationDriver
expect(mail.records[0]?.notification).toBeInstanceOf(WelcomeEmail)
```

Pick the per-test swap for fine-grained tests; pick the config-driven approach when the whole suite runs against mocks.

## Asserting on the dispatched payload

`MockNotificationDriver.records` is `{ notifiable, notification, context }[]`. The notification instance is the actual subclass — you can call its hooks directly to assert on what would have gone out:

```ts
test('InvoicePaid.toMail uses the invoice currency', async () => {
  const { manager } = await bootTestApp()
  const mailMock = new MockNotificationDriver('mail')
  manager.useDriver('mail', mailMock)

  await billing.markPaid({ invoiceId: 'inv_1', amount: 4900, currency: 'THB' })

  const [record] = mailMock.records
  expect(record).toBeDefined()
  // Pull the actual Message that would have hit the transport.
  const message = (record!.notification as InvoicePaid).toMail(record!.notifiable)
  expect(message.subject).toContain('inv_1')
  expect(message.text).toContain('THB')
})
```

This is more robust than asserting on intermediate state — the notification's hook IS the contract; the test reads exactly what the channel driver would have read.

## Counting + clearing

Use `clear()` between assertions when the same test exercises multiple flows:

```ts
test('cancelling a draft does not fire WelcomeEmail', async () => {
  const { manager, signup, cancel } = await bootTestApp()
  const mock = new MockNotificationDriver('mail')
  manager.useDriver('mail', mock)

  await signup.draft({ email: 'a@x' })
  expect(mock.records).toHaveLength(0)              // draft doesn't notify

  mock.clear()
  await cancel('a@x')
  expect(mock.records).toHaveLength(0)              // neither does cancel
})
```

The mock keeps recording across the entire test container's lifetime — `clear()` is the explicit reset. Without it, an earlier dispatch from boot or a fixture leaks into the assertion.

## Asserting the dispatch result

`notifications.send(...)` returns a `NotificationDispatchResult`. The mock driver reports `delivered: true` with `reference: context.id`, so testing the result shape is straightforward:

```ts
test('send fans out to all configured channels', async () => {
  const { manager } = await bootTestApp()
  // ... wire mocks for mail, database, webhook

  const result = await manager.send(alice, new InvoicePaid({ /* ... */ }))

  expect(result.deliveries.map(d => d.channel)).toEqual(['mail', 'database', 'webhook'])
  expect(result.deliveries.every(d => d.delivered)).toBe(true)
})
```

The dispatch `id` is a fresh ULID per call. If you need it deterministic (e.g. snapshot tests), inject a mock ULID source — or normalise it in the assertion before comparing.

## Testing partial failure

To test "mail succeeds, webhook 5xx", subclass `MockNotificationDriver` to throw:

```ts
import { NotificationDeliveryError, MockNotificationDriver } from '@strav/notification'

class FailingMockDriver extends MockNotificationDriver {
  override async send(notifiable, notification, context) {
    throw new NotificationDeliveryError(
      `FailingMockDriver: simulated failure for channel "${this.name}".`,
      { context: { channel: this.name, retryable: true } },
    )
  }
}
```

```ts
test('webhook failure does not block mail or database delivery', async () => {
  const { manager } = await bootTestApp()
  const mail = new MockNotificationDriver('mail')
  const database = new MockNotificationDriver('database')
  const webhook = new FailingMockDriver('webhook')
  manager.useDriver('mail', mail)
  manager.useDriver('database', database)
  manager.useDriver('webhook', webhook)

  const result = await notifications.send(alice, new InvoicePaid({ /* ... */ }))

  expect(result.deliveries).toEqual([
    { channel: 'mail', delivered: true, reference: result.id },
    { channel: 'database', delivered: true, reference: result.id },
    expect.objectContaining({
      channel: 'webhook',
      delivered: false,
      error: expect.any(NotificationDeliveryError),
    }),
  ])
  expect(mail.records).toHaveLength(1)
  expect(database.records).toHaveLength(1)
})
```

The manager never rethrows; it captures the channel-level error into `result.deliveries[i].error`. That contract is itself worth a test if your code branches on it.

## Integration tests with real channels

Mocks cover most cases. For end-to-end flows you wire the real channel drivers and inspect their state. The shipped `m4-notification` e2e (in `tests/e2e/m4-notification/`) is the canonical reference — `ArrayTransport` for mail, real `setupDb` query for the database row, captured `Logger` lines for log. Replicate that pattern for any channel you've written tests for.

```ts
test('InvoicePaid persists with the right type + data', async () => {
  const result = await notifications.send(alice, new InvoicePaid({ invoiceId: 'inv_1', amount: 4900 }))

  const [row] = await setupDb.query<{ id: string; type: string; data: { invoiceId: string } }>(
    `SELECT id, type, data FROM notification WHERE id = $1`,
    [result.id],
  )
  expect(row?.type).toBe('InvoicePaid')
  expect(row?.data.invoiceId).toBe('inv_1')
})
```

Use the dispatch ULID as the query key — it's the same `id` the database row gets, so the test couples cleanly to the actual write rather than relying on "the latest row" semantics.

## Cleaning up between tests

Two patterns, same trade-offs as the mail layer:

1. **Per-test container.** `bootTestApp()` builds a fresh `NotificationManager` each time; the mocks start empty by construction. Slower but bulletproof.
2. **Shared container + `clear()` in `beforeEach`.** Faster, but every test that swaps a driver must clear its records or the next test sees the leak.

Pick one. Mixing them is the source of "this test passes alone but fails in the suite" bugs.

For database-channel integration tests specifically: `TRUNCATE notification` in `beforeEach`. The unread index is small enough that re-priming is instant.

## Testing custom drivers

`MockNotificationDriver` is for the fan-out layer. For testing your own driver's behaviour (e.g. the Slack driver from [custom_channels.md](./custom_channels.md)), stub `fetch` and exercise the driver directly:

```ts
test('SlackNotificationDriver flags 5xx as retryable', async () => {
  const driver = new SlackNotificationDriver({
    name: 'slack_alerts',
    webhookUrl: 'https://hooks.example/x',
    fetch: async () => new Response('overloaded', { status: 503 }),
  })

  class Test extends BaseNotification {
    override via() { return ['slack_alerts'] }
    toSlack() { return { text: 'hi' } }
  }

  let caught: unknown
  try {
    await driver.send({ id: 'u_1' }, new Test(), { id: 'n_1', dispatchedAt: new Date() })
  } catch (err) { caught = err }
  expect((caught as NotificationDeliveryError).context['retryable']).toBe(true)
})
```

See the shipped drivers' tests under `packages/notification/tests/drivers/<channel>/` for the canonical pattern — they exercise hook detection, payload shape, headers, retry classification, and pre-flight validation each driver enforces.
