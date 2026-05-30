// Public API of @strav/broadcast.
//
// Root barrel exports the primitive — `Broadcaster` abstract class +
// types + errors + the in-memory provider. Drivers ship under subpaths:
//   - `@strav/broadcast/memory`   (re-exports for explicit construction)
//   - `@strav/broadcast/postgres` (Postgres polling-ledger backplane)

export {
  BroadcastConfigError,
  BroadcastError,
  BroadcastPublishError,
  BroadcastUnauthorizedError,
} from './broadcast_error.ts'
export {
  BroadcastProvider,
  type MemoryBroadcastConfig,
} from './broadcast_provider.ts'
export { Broadcaster } from './broadcaster.ts'
export {
  type ChannelAuthorizationResult,
  type ChannelAuthorizer,
  ChannelAuthorizerRegistry,
} from './channel_authorizer.ts'
export {
  MemoryBroadcaster,
  type MemoryBroadcasterOptions,
} from './drivers/memory/memory_broadcaster.ts'
export type { BroadcastEvent, BroadcastSubscription } from './types.ts'
