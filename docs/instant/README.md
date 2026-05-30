# @strav/instant

Provider-agnostic abstraction for instant-messaging providers (LINE, WhatsApp Cloud API, Facebook Messenger). One `InstantManager` facade that routes a normalized `OutgoingMessage` into a configured driver; LINE-specific surfaces (Flex Messages, rich menus, LIFF ID-token verification, beacons) ship as a typed subpath at `@strav/instant/line`.

```ts
import { InstantProvider } from '@strav/instant'
import { LineInstantProvider } from '@strav/instant/line'

export default [InstantProvider, LineInstantProvider, /* ... */]
```

```ts
// config/instant.ts
export default {
  default: 'line',
  providers: {
    line: {
      driver: 'line',
      // Messaging API channel (send + webhook):
      channelAccessToken: env('LINE_CHANNEL_ACCESS_TOKEN'),
      channelSecret:      env('LINE_CHANNEL_SECRET'),
      // LIFF / LINE Login channel — only if you use LIFF.
      // NOTE: this is the LINE Login channel id, NOT the
      // Messaging API channel id (they're separate channels).
      liff: { channelId: env('LINE_LOGIN_CHANNEL_ID') },
    },
  },
}
```

```ts
const instant = app.resolve(InstantManager)

// Portable LCD shape — works on every driver.
await instant.send('U1234abcd', {
  text: 'Order confirmed!',
  quickReplies: [
    { label: 'Track', action: { type: 'postback', data: 'track' } },
  ],
})
```

```ts
// LINE-specific richness — typed Flex builder.
import { flex } from '@strav/instant/line'

const bubble = flex.bubble({
  body: flex.box('vertical', [
    flex.text('Order #123', { weight: 'bold' }),
    flex.text('Total: ฿1,200'),
  ]),
  footer: flex.box('horizontal', [
    flex.button({ action: flex.action.postback('Track', 'order=123') }),
  ]),
})

await instant.use('line').send('U1234abcd', {
  raw: { type: 'flex', altText: 'Order #123', contents: bubble },
})
```

## Why a single package?

Three providers, three very different shapes. LINE has LIFF, Flex Messages, rich menus and beacons; WhatsApp enforces template approval and a 24h reply window; Messenger has its own PSID and persona model. The framework exposes:

- **LCD `OutgoingMessage`** (`text`, `attachments`, `quickReplies`) for portable code.
- **Fine-grained `InstantCapability` flags** so apps branch on what the routed driver supports.
- **Per-provider subpath escape hatches** (`@strav/instant/line`) for richness that doesn't map portably.

This pattern mirrors `@strav/payment` (Stripe + Omise + Paddle deferred) and `@strav/notification` (mail / database / log / webhook channels).

## v1 scope

- ✅ **LINE driver** — send / reply / push / multicast / broadcast / profile.
- ✅ **Webhook receiver** — signature verification (HMAC-SHA256 against the channel secret) + event parsing into the framework's normalized `WebhookEvent` union.
- ✅ **Flex Message builder** — typed `flex.*` factories (bubble, carousel, box, text, button, image, separator, action).
- ✅ **LIFF ID-token verification** — `LineLiff.verifyIdToken(idToken)` against LINE's `/oauth2/v2.1/verify`.
- ✅ **Rich menus** — CRUD + per-user assignment via `driver.richMenu`.
- ✅ **Beacons** — surfaced via the normalized `BeaconEvent` variant.

WhatsApp Cloud API and Messenger Platform drivers come in follow-up slices and will register via the same `manager.extend('whatsapp', factory)` hook.

## Guides

- [LINE — getting started](./guides/line-getting-started.md)
- [LINE — webhook handling](./guides/line-webhook.md)
- [LINE — Flex Messages](./guides/line-flex.md)
- [LINE — rich menus](./guides/line-rich-menu.md)
- [LINE — LIFF ID-token verification](./guides/line-liff.md)
- [Capability flag matrix](./reference/capabilities.md)

## Multitenancy

Non-tenanted by default. Apps that need per-tenant routing can configure multiple providers (`providers.{ supportLine, marketingLine }`) and pass the instance name on every call: `instant.use('marketingLine').send(...)`.

## Out of scope

- **LINE Login (OAuth/OIDC)** is in `@strav/social`, not here. This package only validates ID tokens issued by LIFF for backend trust decisions.
- **Webhook routing into HTTP** is left to the app. `instant.verify(...)` + `instant.parseWebhook(...)` do the heavy lifting; the app owns the route declaration so it can apply its own middleware (rate-limiting, observability, replay protection).
