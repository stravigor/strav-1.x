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
// Also shipping:
//   - `DiskCache` — persist compiled templates across process restarts
//     under `storage/cache/views` (configurable). Auto-enabled when
//     `config.view.cache` is on.
//   - `AssetManifest` — real `@asset(path)` versioning. Reads a JSON
//     manifest (Vite-compatible) when present; falls back to mtime
//     query strings in dev.

export { AssetManifest, type AssetManifestOptions } from './asset_manifest.ts'
export type {
  CompilationResult,
  RenderContext,
  RenderFunction,
  RenderResult,
} from './compiler.ts'
export { compile } from './compiler.ts'
export { ViewBuild, ViewCache, ViewClear, ViewConsoleProvider } from './console/index.ts'
export { DiskCache } from './disk_cache.ts'
export { escapeHtml } from './escape.ts'
export {
  type BuildCssOptions,
  type BuildCssResult,
  buildCss,
  type CssEntry,
  normaliseCssEntries,
} from './islands/build_css.ts'
export {
  type BuildIslandsOptions,
  type BuildIslandsResult,
  buildIslands,
  type IslandSource,
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
