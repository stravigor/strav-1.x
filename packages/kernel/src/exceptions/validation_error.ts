/**
 * `ValidationError` — 422, `validation-error`.
 *
 * Carries an optional `errors` map keyed by field path. Field arrays are frozen.
 *
 * @see docs/kernel/api.md
 */

import { type ErrorJSON, StravError, type StravErrorOptions } from './strav_error.ts'

export interface ValidationErrorOptions extends StravErrorOptions {
  /** Field-level errors keyed by dotted path; values are message arrays. */
  errors?: Record<string, readonly string[]>
}

export interface ValidationErrorJSON extends ErrorJSON {
  errors: Record<string, readonly string[]>
}

export class ValidationError extends StravError {
  readonly errors: Readonly<Record<string, readonly string[]>>

  constructor(message = 'Validation failed.', options: ValidationErrorOptions = {}) {
    super(message, { code: 'validation-error', status: 422 }, options)
    const source = options.errors ?? {}
    const frozen: Record<string, readonly string[]> = {}
    for (const [field, messages] of Object.entries(source)) {
      frozen[field] = Object.freeze([...messages])
    }
    this.errors = Object.freeze(frozen)
  }

  override toJSON(): ValidationErrorJSON {
    return {
      ...super.toJSON(),
      errors: { ...this.errors },
    }
  }
}
