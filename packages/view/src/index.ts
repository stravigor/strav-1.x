// Public API of @strav/view — slice 1: core engine.
//
// Shipping:
//   - `tokenize(source)` + `Token` — the lexer (exposed so debug
//     tools and tests can inspect the token stream).
//   - `compile(tokens)` + `CompilationResult` / `RenderFunction` /
//     `RenderContext` / `RenderResult` — produces a callable render
//     function from a token stream. Implements every frozen
//     directive except `@island`.
//   - `escapeHtml(value)` — the HTML escape used by `{{ expr }}` and
//     `@escape(value)`.
//   - `ViewEngine` + `ViewConfig` + `ViewEngineOptions` — the public
//     surface. Resolves template names, compiles, caches, manages
//     layout chains and stacks.
//   - `ViewProvider` — wires `ViewEngine` + the `'view'` alias from
//     `config('view')`.
//   - `TemplateError` — typed `StravError` for tokenize / compile /
//     render failures.
//
// Still to land in later view slices:
//   - `@island` directive + Vue bundler + client hydration runtime.
//   - Pages auto-router (`resources/views/pages/**/*.strav` → routes).
//   - Disk cache + `view:cache` / `view:build` console commands.
//   - Asset versioning (real implementation; stub returns the input
//     path verbatim today).

export type {
  CompilationResult,
  RenderContext,
  RenderFunction,
  RenderResult,
} from './compiler.ts'
export { compile } from './compiler.ts'
export { escapeHtml } from './escape.ts'
export {
  type BuildIslandsOptions,
  type BuildIslandsResult,
  buildIslands,
} from './islands/build_islands.ts'
export { vueSfcPlugin } from './islands/vue_plugin.ts'
export { TemplateError } from './template_error.ts'
export type { Token, TokenType } from './tokenizer.ts'
export { tokenize } from './tokenizer.ts'
export { type ViewConfig, ViewEngine, type ViewEngineOptions } from './view_engine.ts'
export { ViewProvider } from './view_provider.ts'
