/**
 * `rule` — thin façade over Zod for `FormRequest.rules()` definitions.
 *
 * Each builder returns a Zod schema (preserving its chainable type, so
 * `.min/.max/.email/...` still work) tagged with `rule.*` as the source.
 * The wrapper exists to give Strav apps a stable surface that:
 *   - Lines up with the spec language (`rule.email()`, `rule.string()`, …).
 *   - Lets us swap or augment the underlying validator without breaking
 *     user code if Zod's API ever drifts.
 *   - Centralizes the convention that rule failures emit **codes**, not
 *     user-facing messages — the message is filled in at response time
 *     via i18n (currently passes through unchanged).
 *
 * `rule.*` always returns a Zod schema underneath, so `z.*` schemas
 * interop on any field without bridging.
 */

import { z } from 'zod'

import { compileCustomRule } from './rule_registry.ts'

// ─── Primitive builders ───────────────────────────────────────────────────────

export const rule = {
  string: () => z.string(),
  number: () => z.number(),
  boolean: () => z.boolean(),
  date: () => z.date(),
  email: () => z.email(),
  url: () => z.url(),
  uuid: () => z.uuid(),
  ulid: () => z.ulid(),
  enum: <const T extends readonly [string, ...string[]]>(values: T) => z.enum(values),
  array: <T extends z.ZodType>(item: T) => z.array(item),
  object: <T extends z.ZodRawShape>(shape: T) => z.object(shape),
  union: <T extends readonly [z.ZodType, z.ZodType, ...z.ZodType[]]>(options: T) =>
    z.union(options),

  // ─── Convenience composers ──────────────────────────────────────────────────

  /** `value | undefined` — pre-validated absence is allowed. */
  optional: <T extends z.ZodType>(inner: T) => inner.optional(),
  /** `value | null` — explicit null allowed. */
  nullable: <T extends z.ZodType>(inner: T) => inner.nullable(),

  /**
   * Apply a custom rule registered via `registerRule(name, fn)`. Compose with
   * `.pipe(rule.custom(...))` on top of a base schema so the type narrows
   * before the rule runs:
   *
   *   rule.string().min(3).pipe(rule.custom('unique', { table: 'users' }))
   */
  custom: (name: string, args?: Record<string, unknown>) => compileCustomRule(name, args),

  /** Direct Zod escape hatch — `rule.z` is the same `z` you `import`. */
  z,
}

export { z }
