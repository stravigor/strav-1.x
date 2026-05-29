/**
 * `BrainError` — typed wrapper for failures originating in the brain
 * stack. Provider-native errors (e.g. `Anthropic.RateLimitError`) are
 * preserved on `.cause` so apps can `instanceof`-check them when they
 * need provider-specific recovery; the wrapping just gives the
 * framework a consistent `StravError` to render through the standard
 * exception handler.
 *
 * Subclassing surface deferred — V1 has one error type. When a real
 * use case appears for distinguishing "model refused" vs "rate
 * limited" at the framework level (rather than `instanceof
 * Anthropic.RateLimitError` at the call site), a typed hierarchy
 * lands.
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
