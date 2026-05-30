/**
 * `InstantCapability` — granular feature flags every driver declares
 * in `driver.capabilities`. Apps that build provider-neutral flows
 * branch on capability before calling:
 *
 *   if (instant.use('line').capabilities.has('send.flex')) { ... }
 *
 * Granularity is intentionally fine — one flag per non-trivial
 * surface, not one per group — so e.g. WhatsApp can support
 * `send.template` without claiming `send.flex`, and LINE can
 * support `richMenu` and `beacon` without any analogue elsewhere.
 *
 * Drivers omit a capability when they can't fulfil it faithfully.
 * Apps reach into provider-specific subpath imports
 * (`@strav/instant/line`) when they need behaviour that doesn't
 * map to a common capability.
 */

export type InstantCapability =
  // outbound content shapes
  | 'send.text'
  | 'send.image'
  | 'send.video'
  | 'send.audio'
  | 'send.file'
  | 'send.location'
  | 'send.sticker'
  | 'send.quickReplies'
  | 'send.template'
  | 'send.flex'
  // outbound endpoints
  | 'reply'
  | 'push'
  | 'multicast'
  | 'broadcast'
  // identity + relationship
  | 'profile'
  | 'loadingIndicator'
  // platform-specific surfaces
  | 'richMenu'
  | 'beacon'
  | 'liff'
  // inbound
  | 'webhook.signature'
  | 'webhook.parse'
