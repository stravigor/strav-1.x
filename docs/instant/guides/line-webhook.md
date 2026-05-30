# LINE — webhook handling

LINE delivers inbound events (messages, postbacks, follow/unfollow, beacons, …) to a webhook URL you register in the channel's "Messaging API" tab. Every request is signed with HMAC-SHA256 against your **channel secret**.

## The route

```ts
import { Router } from '@strav/http'
import { InstantManager } from '@strav/instant'

const router = app.resolve(Router)

router.post('/webhooks/line', async (ctx) => {
  const instant = ctx.app.resolve(InstantManager)
  const rawBody = await ctx.request.text()           // RAW body — required for HMAC
  const signature = ctx.request.headers.get('x-line-signature')

  if (!instant.verify('line', rawBody, signature)) {
    return ctx.response.status(400).text('invalid signature')
  }

  const events = instant.parseWebhook('line', rawBody)
  for (const event of events) {
    await dispatch(event)
  }
  return ctx.response.status(200).text('ok')
})
```

**Critical:** verify against the **raw** body — any reformatting (re-stringifying parsed JSON) will change the bytes and break the HMAC. Read `request.text()` before any JSON parsing.

## Handling events

`parseWebhook` returns a `WebhookEvent[]` — a discriminated union of normalized variants. Branch on `event.type`:

```ts
async function dispatch(event: WebhookEvent) {
  switch (event.type) {
    case 'message.text':
      await handleText(event)
      break
    case 'postback':
      await handlePostback(event)
      break
    case 'follow':
      await onboardUser(event.userId)
      break
    case 'beacon':
      await trackBeacon(event)
      break
    default:
      // Unknown / unmodelled events keep the raw payload — reach
      // into `event.raw` if you need an exotic LINE variant.
      break
  }
}
```

## Replying

For events that carry a `replyToken` (most message + postback events), `driver.reply(token, message)` is the cheapest way to respond (replies don't count against the push-message quota). Reply tokens are single-use and expire after ~1 minute.

```ts
if (event.type === 'message.text' && event.replyToken) {
  await instant.use('line').reply!(event.replyToken, { text: 'Got it.' })
}
```

## Verifying out-of-band

For tests or HTTP frameworks where you've already got the raw body, the standalone helpers are exported from `@strav/instant/line`:

```ts
import { parseLineWebhook, verifyLineSignature } from '@strav/instant/line'

const ok = verifyLineSignature(rawBody, signature, channelSecret)
const events = ok ? parseLineWebhook(rawBody) : []
```
