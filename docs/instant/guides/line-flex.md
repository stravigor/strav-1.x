# LINE — Flex Messages

Flex Messages are LINE's rich message format — bubbles with a header / hero / body / footer composed from boxes, text, buttons, images, and separators. They're a typed JSON tree; `@strav/instant/line` ships a `flex` builder so you don't hand-write the JSON.

## Single bubble

```ts
import { flex } from '@strav/instant/line'

const bubble = flex.bubble({
  header: flex.box('vertical', [
    flex.text('Order #1234', { weight: 'bold', size: 'lg' }),
  ]),
  body: flex.box('vertical', [
    flex.text('Caesar Salad — ฿180', { size: 'sm' }),
    flex.text('Pad Thai — ฿220', { size: 'sm' }),
    flex.separator(),
    flex.text('Total: ฿400', { weight: 'bold', align: 'end' }),
  ]),
  footer: flex.box('horizontal', [
    flex.button({ style: 'primary', action: flex.action.postback('Track', 'order=1234') }),
    flex.button({ action: flex.action.uri('Receipt', 'https://example.com/r/1234') }),
  ]),
})

await instant.use('line').send('U1234abcd', {
  raw: { type: 'flex', altText: 'Order #1234', contents: bubble },
})
```

The `raw` field bypasses the LCD `text` / `attachments` mapping — LINE receives the Flex JSON verbatim. `altText` is shown in notification previews and to users on older LINE clients.

## Carousel

```ts
const carousel = flex.carousel([
  flex.bubble({ /* product A */ }),
  flex.bubble({ /* product B */ }),
  flex.bubble({ /* product C */ }),
])

await instant.use('line').send(userId, {
  raw: { type: 'flex', altText: 'Featured products', contents: carousel },
})
```

Carousels hold up to 10 bubbles. The whole message JSON is capped at 50 KB.

## Actions

Three action types are common:

- **`flex.action.message(label, text)`** — sends a text message back as if the user typed it.
- **`flex.action.postback(label, data, { displayText? })`** — sends a postback event with `data` to your webhook. `displayText` is shown in the chat as the user's "tap".
- **`flex.action.uri(label, uri)`** — opens a URL (or a LIFF URL — see [LIFF guide](./line-liff.md)).

## When to drop down to raw JSON

The builder covers the common 90%. For shapes it doesn't (linear-gradient backgrounds, spans inside text, video components), hand-write the JSON for that node:

```ts
flex.box('vertical', [
  flex.text('Header'),
  { type: 'video', url: '...', previewUrl: '...', altContent: { /* ... */ } },
])
```

Everything is plain JSON, so mixing builder output with raw nodes composes cleanly.
