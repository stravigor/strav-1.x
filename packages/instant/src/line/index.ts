// Public API of `@strav/instant/line`.
//
// Subpath barrel for the LINE driver. Apps import the
// ServiceProvider and register it in `bootstrap/providers.ts`:
//
// ```ts
// import { InstantProvider } from '@strav/instant'
// import { LineInstantProvider } from '@strav/instant/line'
//
// export default [InstantProvider, LineInstantProvider, ...]
// ```
//
// LINE-only surfaces (`flex`, `LineRichMenu`, `LineLiff`,
// `isBeaconEvent`) are exported here for apps that need them.

export { isBeaconEvent } from './line_beacon.ts'
export type { LineLiffConfig, LineProviderConfig } from './line_config.ts'
export {
  LineDriver,
  type LineDriverOptions,
} from './line_driver.ts'
export {
  type BubbleInput,
  type FlexBox,
  type FlexBubble,
  type FlexButton,
  type FlexCarousel,
  type FlexComponent,
  type FlexContainer,
  type FlexImage,
  type FlexSeparator,
  type FlexText,
  flex,
} from './line_flex.ts'
export {
  type LiffIdTokenClaims,
  LineLiff,
  type VerifyIdTokenOptions,
} from './line_liff.ts'
export { toLineMessages } from './line_message_mapper.ts'
export { LineInstantProvider } from './line_provider.ts'
export { LineRichMenu } from './line_rich_menu.ts'
export {
  parseLineWebhook,
  verifyLineSignature,
} from './line_webhook.ts'
