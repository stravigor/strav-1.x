// Public API of @strav/auth.
//
// IMPORTANT: importing the barrel installs the `ctx.auth` type augmentation
// on `@strav/http`. Apps that import any auth symbol from here get the typed
// `ctx.auth` everywhere automatically.

// Side-effect import — installs the HttpContext.auth augmentation.
import './context_augmentation.ts'

export { assertAuth } from './assert_auth.ts'
export { AuthContext, AuthGuardView } from './auth_context.ts'
export { AuthManager } from './auth_manager.ts'
export { type AuthConfigShape, AuthProvider, type GuardConfigEntry } from './auth_provider.ts'
export { type Authenticatable, isAuthenticatable } from './authenticatable.ts'
export type { Guard, LoginOptions } from './guard.ts'
export { Hasher, type HasherOptions } from './hasher.ts'
export { MemoryGuard, type MemoryGuardOptions } from './memory_guard.ts'
export {
  AUTH_BUILTIN_NAMES,
  type AuthMiddlewareOptions,
  authMiddleware,
  type GuestMiddlewareOptions,
  guestMiddleware,
} from './middleware/index.ts'
