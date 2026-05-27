/**
 * `ConfigError` — 500, `config-error`.
 *
 * Thrown when configuration is invalid or missing at boot. Surfaces early
 * so misconfigured deployments fail fast rather than producing confusing
 * runtime errors later.
 *
 * @see docs/kernel/api.md
 */

import { StravError, type StravErrorOptions } from './strav_error.ts'

export class ConfigError extends StravError {
  constructor(message: string, options: StravErrorOptions = {}) {
    super(message, { code: 'config-error', status: 500 }, options)
  }
}
