# ADR: FormRequest dispatch — explicit `.from(ctx)` + tuple-arity-3, defer type-param detection

**Status:** Accepted (M2)
**Affects:** `@strav/http` (FormRequest, Router)

## Context

`spec/http.md §Requests` describes FormRequest's ergonomic surface as:

```ts
async store(req: StoreUserRequest, ctx: HttpContext): Promise<Response> {
  const data = req.validated()
  ...
}
```

The kernel is expected to inspect the action method's first parameter, see that it's a `FormRequest` subclass, construct it from `ctx`, run the authorize → transform → validate lifecycle, and pass the populated instance as the first argument.

That detection needs runtime parameter-type metadata for the method. TypeScript only emits `design:paramtypes` for **decorated** targets — and our `@inject()` decorator is class-level, which gives us constructor metadata but not method metadata. Per-method metadata requires a per-method decorator (e.g., `@action()`).

## Decision

Two ergonomic shapes ship in this slice. The spec form is deferred.

### 1. Explicit `await SomeRequest.from(ctx)` (always works)

```ts
async store(ctx: HttpContext) {
  const req = await StoreUserRequest.from(ctx)
  const data = req.validated()
  ...
}
```

`FormRequest.from(ctx)` is a static factory that constructs the request, runs `authorize` → `transform` → `validate`, caches the validated payload, and returns the instance. Zero reflection, zero magic, works without any decorator.

### 2. Tuple-arity-3 router sugar

```ts
router.post('/users', [UserController, 'store', StoreUserRequest])
```

The router accepts an optional third tuple element — a `FormRequest` subclass. The kernel detects the 3-arity form, pre-runs `.from(ctx)`, and calls `controller.store(req, ctx)`. Apps get the spec's "no boilerplate in the controller" feel; the dispatch shape is declared at the route, not inferred from method signatures.

### 3. Deferred: param-type detection

The spec form (`(req: StoreUserRequest, ctx)` auto-detected) requires either:

- A new `@action()` method decorator (or making `@inject()` emit per-method metadata when applied to a class — invasive, and would force every action method onto a decorator).
- A runtime convention (e.g., method.length-based heuristic) — fragile, fails silently when the convention is wrong.

Neither is justifiable for a feature whose ergonomic gain is one line per controller method.

## Alternatives considered

- **Implement param-type detection now with a required `@action()` decorator.** Adds friction (every action gains a decorator) for a payoff that the tuple-arity-3 form already covers. The decorator's only purpose would be to emit metadata — semantically empty.
- **Skip the tuple-arity-3 form, ship only `.from(ctx)`.** Tighter scope but loses the "declared at the route, not buried in the controller" property that makes routes auditable at a glance.
- **Method-arity heuristic.** `method.length >= 2 ⇒ assume FormRequest as first arg`. Fragile across overloads, refactors, and arity mismatches.
- **Diverge from the spec permanently — make the tuple-arity-3 form canonical.** Considered. Worth revisiting after seeing how the two shapes feel in the M2 reference apps.

## Trade-offs

- **Two ways to do one thing**, against the spec's "one way" preference. Mitigated by clear guidance in the requests guide: the tuple form is the recommended pattern for action-with-FormRequest; `.from(ctx)` is the escape hatch for actions that conditionally validate.
- **The spec form is documented but unshipped.** Users following `spec/http.md` literally will be confused. Resolved by the doc policy — `docs/` is canonical, and `docs/http/guides/requests-and-validation.md` only describes what ships.
- **Per-method `@action()` decorator is a foreseeable add.** When it lands, both current shapes stay supported; the spec form becomes a third option. No deprecation needed.

## What this is NOT

- Not a rejection of the spec form — only a deferral. Adding `@action()` later is purely additive.
- Not a custom validation engine. `rule.*` is a thin façade over Zod (v4); raw Zod schemas drop into any field. The framework owns the lifecycle + error-shape contract, not the validator.
- Not an i18n integration. Rule callbacks return codes; the framework passes the code through unchanged until `@strav/kernel/i18n` is ready. The shape (`errors[field][n].code/.message/.context`) is stable now.
