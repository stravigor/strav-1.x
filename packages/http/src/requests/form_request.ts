/**
 * `FormRequest` — typed-payload primitive for HTTP controllers.
 *
 * Wraps a `Zod` schema (from `rules()`) plus optional `authorize(ctx)` and
 * `transform(input)` hooks. The lifecycle (`from(ctx)` static factory):
 *
 *   1. Construct the FormRequest with the request's `HttpContext`.
 *   2. Run `authorize(ctx)` — `false` throws `AuthorizationError`, any throw
 *      propagates.
 *   3. Parse the body (`ctx.request.body()`), pass through `transform()`.
 *   4. Validate against the `rules()` schema. Failures throw
 *      `ValidationError` with the spec-shaped errors map.
 *   5. Cache the validated payload for `validated()`.
 *
 * Two usage shapes — both ship in this slice:
 *
 *   - **Explicit (always works):**
 *     ```ts
 *     async store(ctx: HttpContext) {
 *       const req = await StoreUserRequest.from(ctx)
 *       const data = req.validated()
 *       ...
 *     }
 *     ```
 *
 *   - **Tuple-arity-3 sugar:**
 *     ```ts
 *     router.post('/users', [UserController, 'store', StoreUserRequest])
 *     // → kernel pre-runs .from(ctx), then calls store(req, ctx)
 *     ```
 *
 * The spec's type-detected `(req: StoreUserRequest, ctx)` form depends on
 * method-level `design:paramtypes` metadata — gated on a per-method decorator
 * that we haven't introduced yet. See `docs/decisions/form-request-dispatch.md`.
 */

import { AuthorizationError, ValidationError } from '@strav/kernel'
import { z } from 'zod'
import type { HttpContext } from '../context/types.ts'
import { withRuleContext } from './rule_registry.ts'

/**
 * A schema definition the FormRequest accepts. Either a Zod schema for the
 * whole request (use for cross-field rules via `.superRefine`), or a
 * field-name → schema map that `z.object(...)` wraps internally.
 */
export type RulesShape = z.ZodType | Record<string, z.ZodType>

interface ValidationFieldError {
  code: string
  message: string
  context?: Record<string, unknown>
}

export abstract class FormRequest<TValidated = Record<string, unknown>> {
  protected readonly ctx: HttpContext
  private cached: TValidated | undefined

  /**
   * Public to satisfy `FormRequest.from<R>(this: new (ctx) => R, ctx)`'s
   * `this` constraint — TS treats `protected` constructors as a width
   * mismatch with `new (...)` signatures. Apps should still use `from(ctx)`
   * rather than calling the constructor directly; calling `new` skips the
   * authorize → transform → validate lifecycle.
   */
  constructor(ctx: HttpContext) {
    this.ctx = ctx
  }

  // ─── Hooks subclasses override ─────────────────────────────────────────────

  /**
   * Define the validation schema. Either an object of field-rules (Zod
   * schemas, including `rule.*`) or a single Zod schema for the whole
   * request (use the latter for cross-field validation via `.superRefine`).
   */
  abstract rules(): RulesShape

  /**
   * Authorization gate. Defaults to `true`. Return `false` to throw
   * `AuthorizationError`. Throwing your own (e.g., specific `policy.*` code)
   * propagates unchanged.
   */
  authorize(_ctx: HttpContext): boolean | Promise<boolean> {
    return true
  }

  /**
   * Pre-validation mutation. Receives the raw body (or `{}` for empty
   * bodies); return the object that will be validated. Defaults to identity.
   */
  transform(
    input: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    return input
  }

  // ─── Public surface ────────────────────────────────────────────────────────

  /**
   * Typed accessor for the validated payload. Throws if called before
   * `from(ctx)` has populated the cache (typically not user-visible since
   * actions only see the FormRequest after `.from(ctx)` resolves).
   */
  validated(): TValidated {
    if (this.cached === undefined) {
      throw new Error(
        'FormRequest.validated(): called before .from(ctx). Use `await SomeRequest.from(ctx)`.',
      )
    }
    return this.cached
  }

  // ─── Static factory ────────────────────────────────────────────────────────

  /**
   * Build the request, run authorize/transform/validate, return the
   * populated instance. Throws `AuthorizationError` or `ValidationError`
   * on failure.
   */
  static async from<R extends FormRequest>(
    this: new (
      ctx: HttpContext,
    ) => R,
    ctx: HttpContext,
  ): Promise<R> {
    const instance = new this(ctx)
    await instance.run(ctx)
    return instance
  }

  /** The lifecycle, exposed as `protected` for subclasses that need to wrap it. */
  protected async run(ctx: HttpContext): Promise<void> {
    const allowed = await this.authorize(ctx)
    if (!allowed) {
      throw new AuthorizationError(`${this.constructor.name}: authorize() returned false.`, {
        code: 'policy.denied',
      })
    }

    const raw = await readBody(ctx)
    const transformed = await this.transform(raw)
    const schema = toSchema(this.rules())

    const result = await withRuleContext(ctx, () => schema.safeParseAsync(transformed))
    if (!result.success) {
      throw new ValidationError(`${this.constructor.name}: validation failed.`, {
        code: 'validation.failed',
        context: { errors: zodIssuesToErrors(result.error.issues) },
      })
    }

    this.cached = result.data as TValidated
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function readBody(ctx: HttpContext): Promise<Record<string, unknown>> {
  const raw = await ctx.request.body().catch(() => null)
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof ArrayBuffer)) {
    return raw as Record<string, unknown>
  }
  return {}
}

function toSchema(rules: RulesShape): z.ZodType {
  // Zod v4 — `z.ZodType` is the base class for every schema instance, so
  // `instanceof` distinguishes a single-schema rules() vs a field-map.
  if (rules instanceof z.ZodType) return rules
  return z.object(rules)
}

/**
 * Convert Zod's issue list to the framework's `errors[field]: [{code, message, context?}]`
 * shape. We surface the `params.code` set by registered/custom rules; for
 * Zod-native issues we use a `rule.<zod-code>` mapping so codes stay stable
 * even when Zod renames an issue type.
 */
function zodIssuesToErrors(
  issues: readonly z.core.$ZodIssue[],
): Record<string, ValidationFieldError[]> {
  const out: Record<string, ValidationFieldError[]> = {}
  for (const issue of issues) {
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : '_'
    const error = issueToFieldError(issue)
    if (!out[field]) out[field] = []
    out[field].push(error)
  }
  return out
}

function issueToFieldError(issue: z.core.$ZodIssue): ValidationFieldError {
  const params = (issue as { params?: { code?: string; context?: Record<string, unknown> } }).params
  if (params?.code) {
    const error: ValidationFieldError = { code: params.code, message: issue.message }
    if (params.context) error.context = params.context
    return error
  }
  // Zod's own codes are well-known strings: 'invalid_type', 'too_small', 'too_big', etc.
  return {
    code: `rule.${issue.code}`,
    message: issue.message,
  }
}
