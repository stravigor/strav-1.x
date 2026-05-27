/**
 * `ConflictError` — 409, `conflict`.
 *
 * Use for state conflicts (unique constraint about to be violated, optimistic
 * concurrency mismatch, "already exists" semantics). Common in `*.creating` /
 * `*.updating` event listeners that veto a write.
 *
 * @see docs/kernel/api.md
 */

import { StravError, type StravErrorOptions } from './strav_error.ts'

export class ConflictError extends StravError {
  constructor(message = 'Resource conflict.', options: StravErrorOptions = {}) {
    super(message, { code: 'conflict', status: 409 }, options)
  }
}
