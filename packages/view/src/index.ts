// Public API of @strav/view.
//
// Shipping:
//   - `tokenize(source)` + `Token` — the lexer.
//   - `compile(tokens)` + `CompilationResult` / `RenderFunction` /
//     `RenderContext` / `RenderResult`.
//   - `escapeHtml(value)` — the HTML escape.
//   - `ViewEngine` + `ViewConfig` + `ViewEngineOptions` — public surface.
//     Adds `clearCache()` / `warmCache()` / `viewDirectory` getter.
//   - `ViewProvider` — wires `ViewEngine` from `config('view')`.
//   - `buildIslands` + `BuildIslandsOptions` / `BuildIslandsResult`.
//   - `TemplateError` — typed `StravError`.
//   - `ViewConsoleProvider` + `ViewCache` / `ViewClear` / `ViewBuild`
//     console commands (backed by `@strav/cli`).
//
// Still to land:
//   - Disk cache (persist compiled templates across process restarts).
//   - Asset versioning (real implementation; stub returns the input
//     path verbatim today).

export type {
  CompilationResult,
  RenderContext,
  RenderFunction,
  RenderResult,
} from './compiler.ts'
export { compile } from './compiler.ts'
export { ViewBuild, ViewCache, ViewClear, ViewConsoleProvider } from './console/index.ts'
export { escapeHtml } from './escape.ts'
export {
  type BuildIslandsOptions,
  type BuildIslandsResult,
  buildIslands,
} from './islands/build_islands.ts'
export { vueSfcPlugin } from './islands/vue_plugin.ts'
export {
  type DiscoveredPage,
  fileToPage,
  type PagesOptions,
  registerPages,
} from './pages.ts'
export { TemplateError } from './template_error.ts'
export type { Token, TokenType } from './tokenizer.ts'
export { tokenize } from './tokenizer.ts'
export { type ViewConfig, ViewEngine, type ViewEngineOptions } from './view_engine.ts'
export { ViewProvider } from './view_provider.ts'
