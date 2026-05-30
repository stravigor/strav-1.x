# LINE — getting started

A minimal LINE bot using `@strav/instant`.

## Prerequisites

1. Create a LINE Messaging API channel in the [LINE Developers Console](https://developers.line.biz/console/).
2. Copy the **channel access token** and **channel secret** from the channel's "Messaging API" tab.
3. *(Optional — only if you ship a LIFF app)* Create a separate **LINE Login** channel in the same provider, register your LIFF app under it, and copy the **Login channel id**. This is a different channel from the Messaging API one; its id is the `aud` on every LIFF ID token.

## Install + register

```bash
bun add @strav/instant
```

```ts
// bootstrap/providers.ts
import { InstantProvider } from '@strav/instant'
import { LineInstantProvider } from '@strav/instant/line'

export default [
  /* config, logger, ... */
  InstantProvider,
  LineInstantProvider,
]
```

```ts
// config/instant.ts
import { env } from '@strav/kernel'

export default {
  default: 'line',
  providers: {
    line: {
      driver: 'line',
      // Messaging API channel credentials:
      channelAccessToken: env('LINE_CHANNEL_ACCESS_TOKEN'),
      channelSecret:      env('LINE_CHANNEL_SECRET'),
      // LIFF / Login channel (omit when not using LIFF):
      liff: { channelId: env('LINE_LOGIN_CHANNEL_ID', '') },
    },
  },
}
```

## Send a message

```ts
import { InstantManager } from '@strav/instant'

const instant = app.resolve(InstantManager)

await instant.send('U1234abcd', { text: 'Hello!' })
```

`instant.send(...)` routes to the default driver. To target a specific configured provider, use `instant.use('name').send(...)`.

## Reply within the webhook window

LINE inbound events carry a short-lived `replyToken`. Replying with the token is free (push messages count against your monthly quota):

```ts
import type { WebhookEvent } from '@strav/instant'

async function onEvent(event: WebhookEvent) {
  if (event.type === 'message.text' && event.replyToken) {
    await instant.use('line').reply!(event.replyToken, {
      text: `You said: ${event.text}`,
    })
  }
}
```

The `!` is needed because `reply` is optional on `InstantDriver` (not every provider has reply tokens). Guard with `driver.capabilities.has('reply')` for portable code.

## Next steps

- [Webhook handling](./line-webhook.md) — wire `instant.verify` + `instant.parseWebhook` into your HTTP route.
- [Flex Messages](./line-flex.md) — typed builder for richer message layouts.
- [LIFF ID-token verification](./line-liff.md) — trust user identities from LIFF apps.
