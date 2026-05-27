// Auth middleware — public exports.

export { type AuthMiddlewareOptions, authMiddleware } from './auth_middleware.ts'
export { type GuestMiddlewareOptions, guestMiddleware } from './guest_middleware.ts'

/** Canonical middleware names registered by AuthProvider. */
export const AUTH_BUILTIN_NAMES = {
  auth: 'auth',
  guest: 'guest',
} as const
