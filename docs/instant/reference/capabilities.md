# Capability flag matrix

`@strav/instant` exposes a fine-grained `InstantCapability` union so apps can branch on what the routed driver supports without provider-name strings. Each driver declares its capability set via `driver.capabilities`.

```ts
if (instant.use().capabilities.has('send.flex')) {
  // safe to send a Flex bubble via `message.raw`
}
```

## Capability axes

| Flag | Meaning |
|---|---|
| `send.text` | Plain text body. |
| `send.image` | Image attachment. |
| `send.video` | Video attachment. |
| `send.audio` | Audio attachment. |
| `send.file` | File attachment (degrades to text link on providers without native file support). |
| `send.location` | Location attachment (lat/lng + title + address). |
| `send.sticker` | Sticker by `(packageId, stickerId)`. |
| `send.quickReplies` | Inline reply buttons. |
| `send.template` | Provider-native template messages (LINE buttons/confirm/carousel, WhatsApp approved templates). |
| `send.flex` | LINE Flex Messages (JSON bubbles/carousels). |
| `reply` | Reply-token based response (LINE replyToken, WhatsApp context). |
| `push` | Free-form outbound to a known recipient. |
| `multicast` | Same message to many recipients in one call. |
| `broadcast` | Same message to every follower. |
| `profile` | Fetch a user profile by id. |
| `loadingIndicator` | Show "is typing" indicator. |
| `richMenu` | Persistent UI menu (LINE-only today). |
| `beacon` | Bluetooth beacon events (LINE-only today). |
| `liff` | LIFF ID-token verification (LINE-only today). |
| `webhook.signature` | Driver can verify inbound signatures. |
| `webhook.parse` | Driver can normalize inbound events. |

## Per-provider snapshot

| Capability | LINE | WhatsApp (planned) | Messenger (planned) |
|---|:---:|:---:|:---:|
| `send.text`         | ✅ | ✅ | ✅ |
| `send.image/video/audio` | ✅ | ✅ | ✅ |
| `send.location`     | ✅ | ✅ | ✅ |
| `send.sticker`      | ✅ | — | — |
| `send.quickReplies` | ✅ | ✅ | ✅ |
| `send.template`     | ✅ | ✅ | ✅ |
| `send.flex`         | ✅ | — | — |
| `reply`             | ✅ | ✅ | — |
| `push`              | ✅ | ✅ | ✅ |
| `multicast`         | ✅ | — | — |
| `broadcast`         | ✅ | — | — |
| `profile`           | ✅ | — | ✅ |
| `richMenu`          | ✅ | — | — |
| `beacon`            | ✅ | — | — |
| `liff`              | ✅ | — | — |
| `webhook.signature` | ✅ | ✅ | ✅ |
| `webhook.parse`     | ✅ | ✅ | ✅ |

WhatsApp + Messenger rows are forward-looking — those drivers ship in follow-up slices and will declare capabilities that match their own surface area.
