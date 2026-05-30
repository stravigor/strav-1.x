/**
 * `BrainError` hierarchy — typed wrappers for failures originating
 * in the brain stack.
 *
 * Provider-native errors (e.g. `Anthropic.RateLimitError`) are
 * preserved on `.cause` so apps can `instanceof`-check them when
 * they need vendor-specific recovery; the framework wrapping gives
 * a consistent `StravError` to render through the standard
 * exception handler.
 *
 * Subclasses ship in v1 for the boot / lookup / usage paths.
 * Vendor-side runtime errors use `BrainProviderError` as the
 * generic wrapper. Granular vendor classes (rate-limit, content
 * filter, etc.) land when apps actually need to branch on them at
 * the framework level — until then, `instanceof Anthropic.RateLimitError`
 * on `.cause` is the call-site pattern.
 *
 *   - `BrainConfigError` — boot-time misconfiguration (missing
 *     provider in `config.brain.providers`, default key absent).
 *
 *   - `UnknownProviderError` — `brain.provider(name)` for a name
 *     that wasn't registered.
 *
 *   - `BrainUsageError` — pre-condition violations from the
 *     framework's own API contract (e.g. `AgentRunner.run` called
 *     before `input()`).
 *
 *   - `BrainProviderError` — wraps a vendor exception. `cause` is
 *     preserved; default status 502.
 */

import { StravError } from '@strav/kernel'

export class BrainError extends StravError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(
      message,
      { code: 'brain.error', status: 500 },
      { ...options },
    )
  }
}

export class BrainConfigError extends BrainError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown> } = {},
  ) {
    super(message, options)
    // Reassign code/status via the underlying StravError props (the
    // base constructor froze them with `brain.error`); we read them
    // back through getters so subclass-specific overrides surface in
    // logs.
    Object.defineProperty(this, 'code', { value: 'brain.config' })
    Object.defineProperty(this, 'status', { value: 500 })
  }
}

export class UnknownProviderError extends BrainError {
  constructor(name: string, available: readonly string[]) {
    super(
      `Brain provider "${name}" is not registered. Available: ${available.join(', ') || '<none>'}.`,
      { context: { requested: name, available } },
    )
    Object.defineProperty(this, 'code', { value: 'brain.unknown_provider' })
    Object.defineProperty(this, 'status', { value: 400 })
  }
}

export class BrainUsageError extends BrainError {
  constructor(
    message: string,
    options: { context?: Record<string, unknown> } = {},
  ) {
    super(message, options)
    Object.defineProperty(this, 'code', { value: 'brain.usage' })
    Object.defineProperty(this, 'status', { value: 500 })
  }
}

export class BrainProviderError extends BrainError {
  constructor(
    message: string,
    options: {
      provider: string
      operation: string
      context?: Record<string, unknown>
      cause?: unknown
    },
  ) {
    super(message, {
      context: {
        provider: options.provider,
        operation: options.operation,
        ...(options.context ?? {}),
      },
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
    Object.defineProperty(this, 'code', { value: 'brain.provider_error' })
    Object.defineProperty(this, 'status', { value: 502 })
  }
}
