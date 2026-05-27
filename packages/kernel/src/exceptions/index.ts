// exceptions subsystem — public exports.

export { asStravError } from './as_strav_error.ts'
export { AuthError } from './auth_error.ts'
export { AuthorizationError } from './authorization_error.ts'
export { ConfigError } from './config_error.ts'
export { ConflictError } from './conflict_error.ts'
export { NotFoundError } from './not_found_error.ts'
export {
  RateLimitError,
  type RateLimitErrorJSON,
  type RateLimitErrorOptions,
} from './rate_limit_error.ts'
export { ServerError } from './server_error.ts'
export {
  type ErrorJSON,
  isStravError,
  StravError,
  type StravErrorOptions,
} from './strav_error.ts'
export {
  ValidationError,
  type ValidationErrorJSON,
  type ValidationErrorOptions,
} from './validation_error.ts'
