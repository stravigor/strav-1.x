/**
 * `CronExpression` — parses a 5-field cron string + matches it against
 * a `Date`.
 *
 * Fields, in order:
 *   1. minute        (0–59)
 *   2. hour          (0–23)
 *   3. day-of-month  (1–31)
 *   4. month         (1–12)
 *   5. day-of-week   (0–6, Sunday = 0)
 *
 * Per-field syntax:
 *   - `*`         — any value
 *   - `N`         — exactly N
 *   - `A-B`       — every value in `[A, B]` inclusive
 *   - `A,B,C`     — list of values (each item is itself one of the
 *                   above forms)
 *   - `*\/N`      — every Nth value across the full range
 *   - `A-B/N`     — every Nth value across `[A, B]`
 *
 * Time zone: matches against the UTC components of the `Date` —
 * `.getUTCMinutes()` / `.getUTCHours()` / etc. Predictable across
 * machines; apps that need wall-clock scheduling translate by hand at
 * the call site (or supply a `Date` already shifted to local).
 *
 * Name aliases (`jan` / `mon` / etc.) are not supported in V1; use
 * numbers.
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
] as const

export class CronExpression {
  /** The expanded set of acceptable values per field — `Set<number>` × 5. */
  private readonly fields: ReadonlyArray<ReadonlySet<number>>

  constructor(public readonly expression: string) {
    const parts = expression.trim().split(/\s+/)
    if (parts.length !== 5) {
      throw new Error(
        `CronExpression: expected 5 space-separated fields, got ${parts.length}: "${expression}"`,
      )
    }
    this.fields = parts.map((part, i) => {
      const spec = FIELDS[i] as (typeof FIELDS)[number]
      return parseField(part, spec.min, spec.max, spec.name)
    })
  }

  /** True iff `date`'s UTC components fall within every field's accepted set. */
  matches(date: Date): boolean {
    const minute = date.getUTCMinutes()
    const hour = date.getUTCHours()
    const dayOfMonth = date.getUTCDate()
    // JS months are 0–11; cron is 1–12.
    const month = date.getUTCMonth() + 1
    const dayOfWeek = date.getUTCDay()

    return (
      (this.fields[0] as ReadonlySet<number>).has(minute) &&
      (this.fields[1] as ReadonlySet<number>).has(hour) &&
      (this.fields[2] as ReadonlySet<number>).has(dayOfMonth) &&
      (this.fields[3] as ReadonlySet<number>).has(month) &&
      (this.fields[4] as ReadonlySet<number>).has(dayOfWeek)
    )
  }
}

/** Parse one field. Handles `,` lists by recursing on each segment. */
function parseField(part: string, min: number, max: number, label: string): ReadonlySet<number> {
  if (part === '') {
    throw new Error(`CronExpression: empty ${label} field.`)
  }
  const out = new Set<number>()
  for (const segment of part.split(',')) {
    parseSegment(segment, min, max, label, out)
  }
  return out
}

/** Parse a single segment: `*`, `N`, `A-B`, `*\/N`, `A-B/N`. */
function parseSegment(segment: string, min: number, max: number, label: string, into: Set<number>) {
  // Step syntax: split off `/N` if present.
  let baseSegment = segment
  let step = 1
  const slashIdx = segment.indexOf('/')
  if (slashIdx !== -1) {
    baseSegment = segment.slice(0, slashIdx)
    const stepText = segment.slice(slashIdx + 1)
    const parsed = Number.parseInt(stepText, 10)
    if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== stepText) {
      throw new Error(`CronExpression: bad step in ${label} "${segment}".`)
    }
    step = parsed
  }

  let start: number
  let end: number
  if (baseSegment === '*') {
    start = min
    end = max
  } else if (baseSegment.includes('-')) {
    const [aText, bText] = baseSegment.split('-')
    if (aText === undefined || bText === undefined) {
      throw new Error(`CronExpression: bad range in ${label} "${segment}".`)
    }
    const a = Number.parseInt(aText, 10)
    const b = Number.parseInt(bText, 10)
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      String(a) !== aText ||
      String(b) !== bText
    ) {
      throw new Error(`CronExpression: bad range in ${label} "${segment}".`)
    }
    start = a
    end = b
  } else {
    const n = Number.parseInt(baseSegment, 10)
    if (!Number.isInteger(n) || String(n) !== baseSegment) {
      throw new Error(`CronExpression: bad value in ${label} "${segment}".`)
    }
    start = n
    end = n
  }

  if (start < min || end > max) {
    throw new Error(`CronExpression: ${label} value out of range [${min}, ${max}]: "${segment}".`)
  }
  if (start > end) {
    throw new Error(`CronExpression: ${label} range start > end: "${segment}".`)
  }

  for (let v = start; v <= end; v += step) {
    into.add(v)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers — convenience constructors for the common cadences.
// Apps reaching beyond these use `cron(expression)` directly.
// ─────────────────────────────────────────────────────────────────────────────

/** Every minute — `* * * * *`. */
export function everyMinute(): CronExpression {
  return new CronExpression('* * * * *')
}

/** Every N minutes — emits a cron expression with `*\/N` in the minute field. Throws on non-positive N. */
export function everyMinutes(n: number): CronExpression {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`everyMinutes: expected a positive integer, got ${n}.`)
  }
  return new CronExpression(`*/${n} * * * *`)
}

/** Top of every hour — `0 * * * *`. */
export function hourly(): CronExpression {
  return new CronExpression('0 * * * *')
}

/** Midnight UTC daily — `0 0 * * *`. */
export function daily(): CronExpression {
  return new CronExpression('0 0 * * *')
}

/** Daily at a specific UTC time — `dailyAt('14:30')` → `30 14 * * *`. */
export function dailyAt(time: string): CronExpression {
  const match = time.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) {
    throw new Error(`dailyAt: expected HH:MM (24-hour), got "${time}".`)
  }
  const hour = Number.parseInt(match[1] as string, 10)
  const minute = Number.parseInt(match[2] as string, 10)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`dailyAt: time out of range "${time}".`)
  }
  return new CronExpression(`${minute} ${hour} * * *`)
}

/**
 * Escape hatch for non-trivial schedules — accepts any valid 5-field cron
 * expression. Apps that want weekly / monthly / "Mondays at 9" etc. use
 * this directly.
 */
export function cron(expression: string): CronExpression {
  return new CronExpression(expression)
}
