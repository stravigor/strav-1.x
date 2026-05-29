/**
 * Thrown when a transition's guard returns `false` (or its Promise
 * resolves to `false`). Distinct from `TransitionError` so apps can
 * render different UX for "you can't do that from this state" vs
 * "you can't do that right now" — both 422, different `code`.
 *
 * A guard that *throws* (rather than returning `false`) propagates the
 * throw verbatim; this error fires only on the "guard said no" path.
 */

import { StravError } from '@strav/kernel'

export class GuardError extends StravError {
  constructor(transition: string, from: string) {
    super(
      `Guard rejected transition "${transition}" from state "${from}".`,
      { code: 'machine.guard-rejected', status: 422 },
      { context: { transition, from } },
    )
  }
}
