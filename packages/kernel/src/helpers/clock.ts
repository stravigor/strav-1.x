/**
 * `Clock` abstracts "now" so code that depends on the current time can be
 * tested deterministically. Inject `Clock` instead of calling `Date.now()`
 * or `new Date()` directly.
 *
 *   - {@link SystemClock} — real wall-clock; production binding.
 *   - {@link FrozenClock} — manual time control; testing binding.
 *
 * @see docs/kernel/api.md
 */

export interface Clock {
  /** Current time as a `Date`. */
  now(): Date
  /** Milliseconds since the Unix epoch (equivalent to `now().getTime()`). */
  millis(): number
  /** ISO-8601 string representation of the current time. */
  iso(): string
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
  millis(): number {
    return Date.now()
  }
  iso(): string {
    return new Date().toISOString()
  }
}

export class FrozenClock implements Clock {
  private t: number

  constructor(time: number | Date = Date.now()) {
    this.t = time instanceof Date ? time.getTime() : time
  }

  now(): Date {
    return new Date(this.t)
  }
  millis(): number {
    return this.t
  }
  iso(): string {
    return new Date(this.t).toISOString()
  }

  /** Replace the frozen time. */
  set(time: number | Date): void {
    this.t = time instanceof Date ? time.getTime() : time
  }

  /** Move the frozen time forward (or backward, with a negative value) by `ms`. */
  advance(ms: number): void {
    this.t += ms
  }
}
