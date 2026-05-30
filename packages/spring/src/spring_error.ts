/**
 * `SpringError` — error class local to `@strav/spring`.
 *
 * Spring has zero `@strav/*` runtime dependencies (see the template-strategy
 * ADR), so it cannot use `StravError` from `@strav/kernel`. This is a small
 * local equivalent: a typed error so the CLI top-level can distinguish
 * expected user-facing errors from unexpected bugs.
 */
export class SpringError extends Error {
  override readonly name = 'SpringError'
}
