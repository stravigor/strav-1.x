// Public API of `@strav/instant`.
//
// V1: provider-agnostic instant-messaging abstraction —
// normalized `OutgoingMessage` + `WebhookEvent` + multi-provider
// routing. The LINE driver ships as a subpath at
// `@strav/instant/line` with Flex builder, rich menus, beacons,
// and LIFF ID-token verification. WhatsApp + Messenger drivers
// come in follow-up slices.

export {
  InstantConfigError,
  InstantError,
  InstantProviderError,
  ProviderUnsupportedError,
  UnknownProviderError,
  WebhookSignatureError,
} from './errors.ts'
export type { InstantCapability } from './instant_capabilities.ts'
export type {
  InstantDriver,
  InstantDriverFactory,
  UserProfile,
  WebhookOps,
} from './instant_driver.ts'
export {
  InstantManager,
  type InstantManagerOptions,
} from './instant_manager.ts'
export { InstantProvider } from './instant_provider.ts'
export type {
  Attachment,
  OutgoingMessage,
  QuickReply,
  SendResult,
} from './message.ts'
export type {
  InstantConfig,
  ProviderConfig,
} from './types.ts'
export type {
  BeaconEvent,
  FollowEvent,
  JoinEvent,
  LocationMessageEvent,
  MediaMessageEvent,
  PostbackEvent,
  StickerMessageEvent,
  TextMessageEvent,
  UnknownEvent,
  WebhookEvent,
  WebhookEventBase,
} from './webhook_event.ts'
