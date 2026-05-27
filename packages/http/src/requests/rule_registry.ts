/**
 * `RuleRegistry` — named custom rules referenced from `rules()` by string.
 *
 * Declared once at app boot (e.g., from `AppProvider.register()`); applied
 * inline via `rule.custom('name', args?)`. Functions receive the value, a
 * `RuleContext` (the current `HttpContext`), and the args object.
 *
 * Rules return:
 *   - `true` → pass
 *   - `false` → fail with `rule.<name>` as the code
 *   - `string` → fail with that code
 *   - `{ code, context? }` → fail with explicit code + context
 *
 * The framework looks up the code via i18n at response time; for now we pass
 * the code through unchanged (i18n integration is a follow-up).
 */

import { ConfigError } from '@strav/kernel'
import { z } from 'zod'
import type { HttpContext } from '../context/types.ts'

export type RuleContext = HttpContext

export type RuleResult = true | false | string | { code: string; context?: Record<string, unknown> }

export type RuleFn<T = unknown> = (
  value: T,
  ctx: RuleContext,
  args: Record<string, unknown>,
) => RuleResult | Promise<RuleResult>

interface RegistryEntry {
  fn: RuleFn
  defaultCode: string
}

class RuleRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  register<T = unknown>(name: string, fn: RuleFn<T>): void {
    if (this.entries.has(name)) {
      throw new ConfigError(`rule.register: "${name}" is already registered.`)
    }
    this.entries.set(name, { fn: fn as RuleFn, defaultCode: `rule.${name}` })
  }

  /** Replace an existing registration. Used in tests + framework overrides. */
  replace<T = unknown>(name: string, fn: RuleFn<T>): void {
    this.entries.set(name, { fn: fn as RuleFn, defaultCode: `rule.${name}` })
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  get(name: string): RegistryEntry | undefined {
    return this.entries.get(name)
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Module-level singleton — registry state survives across requests. */
const REGISTRY = new RuleRegistry()

export function registerRule<T = unknown>(name: string, fn: RuleFn<T>): void {
  REGISTRY.register(name, fn)
}
export function replaceRule<T = unknown>(name: string, fn: RuleFn<T>): void {
  REGISTRY.replace(name, fn)
}
export function hasRule(name: string): boolean {
  return REGISTRY.has(name)
}
export function clearRules(): void {
  REGISTRY.clear()
}

/**
 * Symbol stored on the context so the validation pipeline can hand the
 * current `HttpContext` to each rule callback (Zod's refine context doesn't
 * carry user data, so we thread it via a context object at validate time).
 */
export const RULE_CONTEXT_KEY = Symbol.for('@strav/http/RULE_CONTEXT')

/**
 * Build a Zod schema that invokes the registered rule. Used by `rule.custom`.
 * Returns `z.any()` so `.pipe()` upstream can preserve the input type — the
 * rule itself doesn't transform the value, it only validates.
 */
export function compileCustomRule(name: string, args: Record<string, unknown> = {}) {
  return z.any().superRefine(async (value, refineCtx) => {
    const entry = REGISTRY.get(name)
    if (!entry) {
      refineCtx.addIssue({
        code: 'custom',
        message: `rule "${name}" is not registered`,
        params: { code: `rule.${name}.unregistered` },
      })
      return
    }
    const httpCtx = currentRuleContext()
    if (!httpCtx) {
      refineCtx.addIssue({
        code: 'custom',
        message: `rule "${name}" requires an HttpContext but none is bound`,
        params: { code: `rule.${name}.no_context` },
      })
      return
    }
    const result = await entry.fn(value as never, httpCtx, args)
    if (result === true) return
    const { code, context } = normalizeRuleResult(result, entry.defaultCode)
    refineCtx.addIssue({
      code: 'custom',
      message: code,
      params: context ? { code, context } : { code },
    })
  })
}

/**
 * Thread-local-ish HttpContext for rule execution. Set by `FormRequest.validate`
 * via `withRuleContext`; read by `compileCustomRule` and `.refine` wrappers.
 *
 * Implemented as an AsyncLocalStorage in Node/Bun environments — async rule
 * chains preserve the context across awaits without each rule having to be
 * passed the ctx explicitly.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const STORAGE = new AsyncLocalStorage<HttpContext>()

export function withRuleContext<T>(ctx: HttpContext, fn: () => Promise<T>): Promise<T> {
  return STORAGE.run(ctx, fn)
}

export function currentRuleContext(): HttpContext | undefined {
  return STORAGE.getStore()
}

function normalizeRuleResult(
  result: Exclude<RuleResult, true>,
  defaultCode: string,
): { code: string; context?: Record<string, unknown> } {
  if (result === false) return { code: defaultCode }
  if (typeof result === 'string') return { code: result }
  return result
}
