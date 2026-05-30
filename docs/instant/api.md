# @strav/instant — API reference

Public API of `@strav/instant` and the `@strav/instant/line` subpath.

## Top-level (`@strav/instant`)

### `InstantManager`

Driver-routing facade. Construct via `InstantProvider` or instantiate directly in tests.

```ts
new InstantManager({ config: InstantConfig })
```

Members:

- `use(name?: string): InstantDriver` — resolve the named driver (default when omitted). Lazy + memoized.
- `extend(driverName: string, factory: InstantDriverFactory): void` — register a driver factory. Adapter packages call this from their ServiceProvider.
- `useDriver(instanceName: string, driver: InstantDriver): void` — hand-wire a driver instance (tests).
- `send(to: string, message: OutgoingMessage): Promise<SendResult>` — delegate to the default driver.
- `verify(provider: string, rawBody: string, signature: string | null | undefined): boolean` — webhook signature verification on the named driver.
- `parseWebhook(provider: string, rawBody: string): WebhookEvent[]` — normalize a verified raw webhook body.

### `InstantProvider`

`ServiceProvider` that binds `InstantManager` to the container from `config.instant`. Eager `boot()` validates config upfront.

### `InstantDriver`

Driver contract every adapter implements:

```ts
interface InstantDriver {
  readonly name: string
  readonly instanceName: string
  readonly capabilities: ReadonlySet<InstantCapability>

  send(to: string, message: OutgoingMessage): Promise<SendResult>
  reply?(replyToken: string, message: OutgoingMessage): Promise<SendResult>
  push?(to: string, message: OutgoingMessage): Promise<SendResult>
  multicast?(to: readonly string[], message: OutgoingMessage): Promise<SendResult>
  broadcast?(message: OutgoingMessage): Promise<SendResult>
  profile?(userId: string): Promise<UserProfile>

  readonly webhook: WebhookOps
}

interface WebhookOps {
  verifySignature(rawBody: string, signature: string | null | undefined): boolean
  parse(rawBody: string): WebhookEvent[]
}
```

### `OutgoingMessage`

Lowest-common-denominator message shape:

```ts
interface OutgoingMessage {
  text?: string
  attachments?: Attachment[]
  quickReplies?: QuickReply[]
  raw?: unknown               // provider-native escape hatch
}

type Attachment =
  | { type: 'image'; url: string; previewUrl?: string }
  | { type: 'video'; url: string; previewUrl?: string; durationMs?: number }
  | { type: 'audio'; url: string; durationMs?: number }
  | { type: 'file';  url: string; fileName?: string; sizeBytes?: number }
  | { type: 'location'; latitude: number; longitude: number; title?: string; address?: string }
  | { type: 'sticker';  packageId: string; stickerId: string }

interface QuickReply {
  label: string
  action:
    | { type: 'message';  text: string }
    | { type: 'postback'; data: string; displayText?: string }
    | { type: 'uri';      uri: string }
  iconUrl?: string
}
```

### `WebhookEvent`

Discriminated union of inbound events. See [`reference/capabilities.md`](./reference/capabilities.md) for the per-provider matrix and [`webhook_event.ts`](../../packages/instant/src/webhook_event.ts) for the full type definitions.

Variants: `message.text`, `message.image|video|audio|file`, `message.location`, `message.sticker`, `postback`, `follow`, `unfollow`, `join`, `leave`, `beacon`, `unknown`.

### `InstantConfig`

```ts
interface InstantConfig {
  default: string
  providers: Record<string, ProviderConfig>
}

interface ProviderConfig {
  driver: string
  [key: string]: unknown   // driver-specific fields
}
```

### Errors

All extend `InstantError` (which extends `StravError` from `@strav/kernel`):

- `InstantConfigError` — missing or malformed `config.instant`.
- `UnknownProviderError` — `instant.use('x')` for an unregistered name.
- `ProviderUnsupportedError` — driver doesn't implement the requested operation.
- `WebhookSignatureError` — signature header missing or malformed.
- `InstantProviderError` — generic wrapper around vendor failures (`.cause` preserves the original).

## Subpath: `@strav/instant/line`

### `LineDriver`

`InstantDriver` for LINE. Wraps `@line/bot-sdk`'s `LineBotClient`.

```ts
new LineDriver({
  instanceName: 'line',
  config: LineProviderConfig,
  client?: LineBotClient,   // injectable for tests
})
```

Exposes the full `InstantDriver` surface plus:

- `driver.client: LineBotClient` — escape hatch into the SDK.
- `driver.liff: LineLiff` — throws when `channelId` is not configured.
- `driver.richMenu: LineRichMenu` — lazy.

### `LineInstantProvider`

`ServiceProvider`. Calls `manager.extend('line', factory)` in `register()`. List after `InstantProvider` in `bootstrap/providers.ts`.

### `LineProviderConfig`

```ts
interface LineProviderConfig extends ProviderConfig {
  driver: 'line'
  // Messaging API channel (send + webhook):
  channelAccessToken: string
  channelSecret: string
  // LIFF / LINE Login channel (separate from Messaging API):
  liff?: { channelId: string }
  apiBaseURL?: string
  dataApiBaseURL?: string
}
```

**LINE splits the bot surface across two different channels** in the Developers Console:

1. **Messaging API channel** issues `channelAccessToken` + `channelSecret`. Used for `send` / `reply` / `push` / webhook signature verification / rich menus.
2. **LINE Login channel** is a separate channel that LIFF apps are bound to. The `aud` claim on a LIFF ID token is *this* channel's id, not the Messaging channel's. Apps that use LIFF must set `liff.channelId` to the **LINE Login channel id**. Copying the Messaging channel id into `liff.channelId` is the most common misconfiguration and produces audience-mismatch failures on every verify.

### `flex`

Typed builder for Flex Message JSON.

```ts
flex.bubble({ header?, hero?, body?, footer?, styles? })
flex.carousel(bubbles: FlexBubble[])
flex.box(layout, contents, options?)
flex.text(value, options?)
flex.button(options)
flex.image(url, options?)
flex.separator(options?)
flex.action.message(label, text)
flex.action.postback(label, data, { displayText? })
flex.action.uri(label, uri)
```

The returned values are plain JSON assignable to `messagingApi.FlexContainer` / `FlexComponent`. Wrap a container in `{ type: 'flex', altText, contents }` and pass it as `message.raw`.

### `LineLiff`

```ts
new LineLiff(channelId: string)
liff.verifyIdToken(idToken: string, options?: VerifyIdTokenOptions): Promise<LiffIdTokenClaims>
```

POSTs to `https://api.line.me/oauth2/v2.1/verify` with the channel id and returns the decoded claims. **Always validate ID tokens server-side** — never trust a userId received directly from a LIFF frontend.

### `LineRichMenu`

```ts
const rm = driver.richMenu
await rm.create(richMenuRequest): Promise<string>
await rm.delete(richMenuId)
await rm.setImage(richMenuId, image: Blob)
await rm.setDefault(richMenuId)
await rm.linkToUser(userId, richMenuId)
await rm.unlinkFromUser(userId)
```

### `parseLineWebhook` / `verifyLineSignature`

Standalone helpers — `LineDriver.webhook` delegates to these. Useful for tests or non-DI integrations.

```ts
verifyLineSignature(rawBody, signature, channelSecret): boolean
parseLineWebhook(rawBody): WebhookEvent[]
```

### `toLineMessages`

Map an `OutgoingMessage` → LINE `Message[]` directly without instantiating a driver. Useful for tests that assert on the wire payload.

### `isBeaconEvent(event): event is BeaconEvent`

Type-guard helper for the LINE-only `BeaconEvent` variant.
