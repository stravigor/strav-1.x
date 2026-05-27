// Middleware subsystem — public exports.

export { composeMiddleware, type FinalHandler } from './compose.ts'
export {
  type MiddlewareEntry,
  type MiddlewareFactory,
  MiddlewareRegistry,
} from './registry.ts'
export type {
  ComposedChain,
  MiddlewareClass,
  MiddlewareDef,
  MiddlewareFn,
  NextFn,
} from './types.ts'
