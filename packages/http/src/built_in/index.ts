// Built-in middleware — public exports.
//
// `HttpProvider` auto-registers each of these under the canonical name listed
// in `BUILTIN_NAMES`. Apps that want to swap a built-in call
// `MiddlewareRegistry.replace(name, def)` from a downstream provider's
// `register()` — see `docs/http/guides/built-ins.md`.

export {
  type CorsOptions,
  corsMiddleware,
} from './cors.ts'
export { RequestLog } from './request_log.ts'
export {
  type SecurityHeadersOptions,
  securityHeadersMiddleware,
} from './security_headers.ts'

/** Canonical names by which these middleware register in the kernel. */
export const BUILTIN_NAMES = {
  cors: 'cors',
  requestLog: 'request_log',
  securityHeaders: 'security_headers',
} as const
