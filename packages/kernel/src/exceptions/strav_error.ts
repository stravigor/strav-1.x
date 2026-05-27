/**
 * `StravError` is the abstract base every framework-raised error inherits from.
 *
 * Each subclass fixes a `code` (machine-readable, kebab/snake) and a `status`
 * (HTTP). User code can override `code` per-instance via {@link StravErrorOptions}.
 *
 * Public surface:
 *   - `error.code`, `error.status`, `error.context`, `error.cause`, `error.message`
 *   - `error.toJSON()` for safe log/render serialization
 *   - {@link isStravError} type-guard
 *
 * @see docs/kernel/api.md
 * @see spec/errors-and-logging.md
 */

export interface StravErrorOptions {
  /** Override the default code for this subclass. */
  code?: string
  /** Structured payload attached to the error for log/render. */
  context?: Record<string, unknown>
  /** Underlying cause (mirrors the standard `Error.cause` option). */
  cause?: unknown
}

export interface ErrorJSON {
  name: string
  code: string
  status: number
  message: string
  context?: Record<string, unknown>
}

export abstract class StravError extends Error {
  /** Machine-readable error code. Subclass-default unless overridden via options. */
  readonly code: string
  /** HTTP-shaped status; subclass-fixed. */
  readonly status: number
  /** Structured payload — frozen at construction. */
  readonly context: Readonly<Record<string, unknown>>

  protected constructor(
    message: string,
    defaults: { code: string; status: number },
    options: StravErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = this.constructor.name
    this.code = options.code ?? defaults.code
    this.status = defaults.status
    this.context = Object.freeze({ ...options.context })
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  /**
   * Plain-object form safe for logging or HTTP rendering. Subclasses may
   * extend this to surface their own fields (see `ValidationError`).
   */
  toJSON(): ErrorJSON {
    const json: ErrorJSON = {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
    }
    if (Object.keys(this.context).length > 0) {
      json.context = { ...this.context }
    }
    return json
  }
}

/** Type-guard: `true` when `err` is any subclass of `StravError`. */
export function isStravError(err: unknown): err is StravError {
  return err instanceof StravError
}
