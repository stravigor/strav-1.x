/**
 * Thrown when a transition isn't valid from the entity's current state
 * (or the transition name isn't defined on the machine at all).
 *
 * `context.transition` names the transition the caller tried; `context.from`
 * is the entity's current state; `context.allowedFrom` is the array of
 * source states the transition would have accepted — or `null` when the
 * transition name is undefined entirely.
 *
 * Status is 422 (unprocessable) rather than 400 because the request is
 * well-formed; the *entity* is in the wrong state for the requested action.
 * Apps that want a different code can override per-instance via the
 * standard `code` field on `StravErrorOptions`.
 */

import { StravError } from '@strav/kernel'

export class TransitionError extends StravError {
  constructor(transition: string, from: string, allowedFrom?: readonly string[]) {
    const message = allowedFrom
      ? `Cannot apply transition "${transition}" from state "${from}". Allowed from: [${allowedFrom.join(', ')}].`
      : `Transition "${transition}" is not defined on this machine.`
    super(
      message,
      { code: 'machine.invalid-transition', status: 422 },
      {
        context: {
          transition,
          from,
          allowedFrom: allowedFrom ? [...allowedFrom] : null,
        },
      },
    )
  }
}
