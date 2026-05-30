# @strav/view — API Reference

> **Status:** Feature-complete for 1.0. Engine + islands + pages auto-router + console commands (`view:cache` / `view:clear` / `view:build`) + disk cache + asset versioning all shipped. Remaining gaps (`@csrf` / `@method` / `@route` are stubs until the `@strav/http` session + named-route map is wired in) are intentional cross-package wiring, not view-package work.

## `Token` / `TokenType`

```ts
type TokenType = 'text' | 'escaped' | 'raw' | 'directive'

interface Token {
  type: TokenType
  /** text body, expression source, or directive NAME (without `@`) */
  value: string
  /** for directives: the source between `(` and `)`. Empty when no parens */
  args?: string
  /** 1-based line where the token starts */
  line: number
}
```

The lexer's output. Exposed for debug tooling — `view.tokenize(source)` returns a `Token[]` for inspection.

## `tokenize(source)`

```ts
function tokenize(source: string): Token[]
```

Pure function. Single pass. Throws `TemplateError` on unclosed `{{`, `{!!`, `{{--`, or `@directive(...)` arg lists; also on unclosed `@raw` or stray `@endraw`.

Directives are recognised by membership in the frozen directive set — anything else (including emails like `hello@example.com`) is treated as literal text. Inside `@raw ... @endraw`, the body is captured verbatim regardless of `{{ }}` / `@…`.

## `compile(tokens)`

```ts
function compile(tokens: readonly Token[]): CompilationResult

interface CompilationResult {
  render: RenderFunction              // call with (data, ctx)
  layout?: string                     // set when the template had @extends
  source: string                      // compiled JS source — for debug
}

type RenderFunction = (
  data: Record<string, unknown>,
  ctx: RenderContext,
) => Promise<RenderResult>

interface RenderResult {
  html: string
  slots: Record<string, string>
  stacks: Record<string, string[]>
}

interface RenderContext {
  escape: (v: unknown) => string
  include: (name: string, data: Record<string, unknown>) => Promise<string>
  section: (name: string, body: string) => void
  setValue: (name: string, value: unknown) => void
  yieldSection: (name: string) => string
  push: (name: string, body: string) => void
  prepend: (name: string, body: string) => void
  stackOf: (name: string) => string
  csrf: () => string
  method: (verb: string) => string
  route: (name: string, params?: Record<string, unknown>) => string
  asset: (path: string) => string
  component: (name: string, props: Record<string, unknown>, slot: string) => Promise<string>
}
```

Compiles to a JS render function via `new Function(...)`. Compile-time validation:
- Block balance — `@if` requires `@endif`, etc.
- Argument shape — `@each` expects `<item> in <collection>`; `@section('name')` etc. require a string literal first arg.
- Frozen directive set — `@island` throws "not implemented yet" (reserved for the next slice).

Runtime errors in `{{ expr }}` / `{!! expr !!}` / directive args surface as `TemplateError` with the original `cause`.

The render function takes a `RenderContext` so the engine can inject the include / section / stack / helper plumbing. App code never builds a `RenderContext` directly — `ViewEngine.render()` constructs one per render.

## `escapeHtml(value)`

```ts
function escapeHtml(value: unknown): string
```

Encodes `&`, `<`, `>`, `"`, `'`. `null` / `undefined` render as the empty string (not the literal text). The implementation behind every `{{ expr }}` and `@escape(expr)`.

## `ViewEngine`

```ts
class ViewEngine {
  constructor(opts: ViewEngineOptions)
  render(name: string, data?: Record<string, unknown>): Promise<string>
  clearCache(): void
  clearDiskCache(): Promise<void>
  warmCache(): Promise<{ warmed: string[]; errors: Array<{ name: string; error: unknown }> }>
  readonly viewDirectory: string
  readonly diskCacheDirectory: string | undefined
}

interface ViewConfig {
  directory?: string                                // default 'resources/views'
  cache?: boolean                                   // default true
  globals?: Record<string, unknown>                 // merged into every render's data
  diskCache?: boolean | { directory?: string }     // default true → 'storage/cache/views'
  assets?: false | AssetManifestOptions            // default {} (manifest-aware @asset)
  islandsDir?: string                              // default 'resources/islands'
  islandsOut?: string                              // default 'public/assets/islands'
  pages?: {
    autoRoute?: boolean                            // default true
    middleware?: readonly string[]                 // empty by default
    pagesDir?: string                              // default '<directory>/pages'
  }
}

interface ViewEngineOptions {
  config: ViewConfig
  read?: (absolutePath: string) => Promise<string>  // injected for tests
}
```

**Name resolution.** `view.render('pages.dashboard', ...)` → `{directory}/pages/dashboard.strav`. Dots in the name become path separators. Names that resolve outside the configured `directory` throw `TemplateError` — defence against template-name path traversal.

**Compilation + cache.** Tokenise + compile on first hit; cache the render function in memory keyed by template name. Disable the cache for dev (`config.view.cache = false`) so edits take effect without restart.

**Disk cache.** When `cache: true` (the default), compiled output is also persisted to `config.view.diskCache.directory` (default `storage/cache/views`). On boot, the first `render()` for each template reads from disk instead of re-tokenising — useful for production where templates don't change between deploys. The on-disk key is a hash of the template source, so any edit auto-invalidates. Disk cache is a speed-up, not a correctness layer: write/read failures fall back to in-process compilation. Disable with `diskCache: false`. Wipe with `view:clear` or `ViewEngine.clearDiskCache()`.

**Asset versioning.** `@asset(path)` routes through an `AssetManifest` by default. When `<publicDir>/manifest.json` exists, it maps logical paths (`'css/app.css'`) to fingerprinted output paths (`'css/app.abc123.css'`); both the Strav-flat (`{ "x": "y" }`) and Vite (`{ "x": { "file": "y" } }`) shapes are accepted. Without a manifest, the resolver falls back to `?v=<mtime-hash>` query strings when the file exists under `publicDir`. Configure via `config.view.assets` (`{ publicDir?, manifest?, prefix? }`); opt out with `assets: false` for pure pass-through.

**Layout chain.** When a template `@extends('layouts.app')`, the child renders first (populating the shared section + stack pool), then the parent renders with the pool available to `@yield` / `@stack`. The chain can nest — grandparents work too. A 50-deep guard prevents infinite recursion (circular `@extends` / `@include`).

**Includes.** `@include('partials.alert', { kind: 'info' })` runs at render time — the engine resolves + renders the partial with the merged data, and returns its HTML to the parent's output stream. The include shares the same section/stack pool, so `@push` inside an include feeds a later `@stack` in the parent (subject to textual order — pushes before stacks).

**Globals.** `config.view.globals` is merged into every render's data, with per-call data winning on collision.

**Standard helpers.** `@csrf`, `@method`, `@route`, `@asset` resolve to stub implementations in slice 1 — real wiring lands when `@strav/http`'s Router and the asset bundler arrive. See the per-helper notes below.

## `ViewProvider`

```ts
class ViewProvider extends ServiceProvider {
  readonly name = 'view'
  readonly dependencies = ['config']
}
```

Reads `config('view')` (or uses defaults if absent), constructs a `ViewEngine`, binds:
- `ViewEngine` (singleton)
- `'view'` (string alias)

Unlike `MailProvider`, `ViewProvider` does NOT require config — apps with templates under `resources/views/` and the default cache setting can use the provider with zero config.

## `TemplateError`

```ts
class TemplateError extends StravError {
  readonly code: 'template-error'
  readonly status: 500
  readonly context: Readonly<Record<string, unknown>>
}
```

Thrown for:
- **Tokenize failures**: unclosed interpolation / comment / directive args / `@raw` block. `context.line` carries the source line.
- **Compile failures**: unknown directive, unbalanced blocks, malformed args. `context.line` carries the directive's line.
- **Render failures**: missing template file, depth-limit exceeded, expression throws inside `{{ }}` / args. `cause` carries the original throwable.

`status: 500` reflects "template bug in app source." Surface a generic 500 to the user upstream; the developer sees the full error in logs.

## Directive catalog

### `@if(expr)` / `@elseif(expr)` / `@else` / `@endif`

JavaScript truthiness. Standard conditional chain.

### `@for(expr)` / `@endfor`

Pass-through to JavaScript `for (...)`. Useful when you want full destructuring or non-standard iteration:

```strav
@for(item of items)
  <li>{{ item.name }}</li>
@endfor

@for(const [k, v] of Object.entries(map))
  <dt>{{ k }}</dt><dd>{{ v }}</dd>
@endfor
```

### `@each(item in collection)` / `@empty` / `@endeach`

Iteration with an optional empty-fallback. The collection is iterated via `Symbol.iterator`; the `@empty` body renders when iteration yields zero items.

```strav
@each(post in posts)
  <h2>{{ post.title }}</h2>
@empty
  <p>No posts yet.</p>
@endeach
```

`@empty` takes no args. The body between `@empty` and `@endeach` is the empty-case template.

### `@extends('layouts.<name>')`

Declare a parent layout. Must be a string literal. At most one per template.

### `@section('name')` ... `@endsection` and `@set('name', value)`

Two shapes for writing to a layout slot:

```strav
@section('content')
  <h1>Hello</h1>
@endsection

@set('title', 'Dashboard')
```

`@section` is the block form (always opened + closed). `@set` is the value form (single-line; the value is escaped before being yielded).

Both feed `@yield('name')` in the layout. The slot's value is the LAST writer's output.

### `@yield('name')`

Read a slot. Empty string if the slot was never written.

### `@include('name')` / `@include('name', data)`

Render a partial inline. `data` is any expression evaluating to an object — its keys become locals in the partial. Without `data`, the partial sees the parent's locals.

```strav
@include('partials.alert', { kind: 'error', text: 'Oops' })
```

The partial shares the section + stack pool with the parent — `@push` inside a partial reaches a later `@stack` in the page.

### `@push('name')` / `@endpush`, `@prepend('name')` / `@endprepend`, `@stack('name')`

Named stacks. `@push` appends; `@prepend` prepends; `@stack` renders the joined contents.

```strav
@push('head')
  <link rel="stylesheet" href="/dashboard.css">
@endpush

{{-- in layout: --}}
<head>@stack('head')</head>
```

Within a single template, `@push` must precede `@stack` textually. Across an `@extends` chain, child pushes always reach the layout's stack — the layout renders after the child.

### `@csrf`

Stub in slice 1 — emits `<input type="hidden" name="_token" value="">`. Real CSRF token wiring lands with `@strav/http`'s session middleware.

### `@method('VERB')`

Hidden input for HTTP method spoofing on `<form>`s — emits `<input type="hidden" name="_method" value="PUT">`. `@strav/http`'s method-override middleware reads it.

### `@route('name')` / `@route('name', { ...params })`

Reverse-routing helper. Slice 1 stub returns the route name verbatim. Real wiring lands when `@strav/http`'s named-route map is available to the engine.

### `@asset('path/to/file')`

Asset URL helper. Resolves through the `AssetManifest` configured on the engine — see the `ViewEngine` "Asset versioning" note. With a Strav-flat / Vite-style `manifest.json` present, returns the fingerprinted URL (`/css/app.abc123.css`). Without one, falls back to mtime-based query strings in dev (`/css/app.css?v=deadbe`). Set `config.view.assets = false` to get the original pass-through behaviour.

### `@raw` / `@endraw`

Suppress directive + interpolation parsing inside the block — useful for emitting client-side handlebars-style templates, code blocks, etc.

```strav
@raw
  Hello {{ this is literal }}
  @notADirective
@endraw
```

### `@escape(expr)`

Explicit escape. Equivalent to `{{ expr }}` but lets you compose with literal HTML in the surrounding directive:

```strav
<input value="@escape(user.bio)">
```

### `@component('name', { ...props })` / `@endcomponent`

Render a `resources/views/components/<name>.strav` template with the given props as locals plus `slot` set to the captured body content.

```strav
@component('alert', { kind: 'success' })
  Saved successfully.
@endcomponent
```

```strav
{{-- components/alert.strav --}}
<div class="alert alert-{{ kind }}">
  {!! slot !!}
</div>
```

Components have no script / style — they are pure server templates. For client interactivity, use `@island` (coming in the next slice).

### `@island('Name', { ...props })`

Emit a Vue island — a small interactive UI mounted into an otherwise server-rendered page.

```strav
@island('LeadKanban', { initial: leadsForKanban })
```

Compiles to a marker only:

```html
<div data-island="LeadKanban" data-props="{...escaped JSON...}"></div>
```

The page loads ONE shared bundle (`/assets/islands/islands.js`) via a `<script type="module" src="…" defer>` tag in the layout. That bundle contains every island your app defines plus its `setup.ts` hooks. It scans the DOM for every `[data-island]` element it finds, looks up each name in the bundled component registry, and mounts a `<Teleport>` per element into a single shared Vue app.

**One app, many islands.** All islands on a page run inside the SAME `createApp(Root)` — that's the load-bearing property. `app.use(createPinia())` in `setup.ts` makes one Pinia instance available to every island; a store mutation in `palette.vue` is reactive in `canvas.vue` without further wiring.

**Props serialisation.** Props are JSON-stringified then HTML-attr-escaped. Anything that survives `JSON.stringify` round-trips cleanly (`Date` becomes a string, `undefined` is dropped, etc.). For non-serialisable state, fetch it client-side from inside the Vue component.

**Loading the bundle.** Apps include the script ONCE in their layout — typically inside `<head>` or just before `</body>`:

```strav
{{-- resources/views/layouts/app.strav --}}
<head>
  <script type="module" src="@asset('islands/islands.js')" defer></script>
</head>
```

The engine does NOT auto-emit this — every layout is different, so the framework leaves placement to the app.

## `buildIslands(opts)`

```ts
function buildIslands(opts: BuildIslandsOptions): Promise<BuildIslandsResult>

interface BuildIslandsOptions {
  inputDir: string                       // resources/ts/islands
  outputDir: string                      // public/assets/islands
  minify?: boolean                       // default true
  sourcemap?: boolean                    // default false (inline when true)
  external?: string[]                    // e.g. ['vue'] to load Vue from CDN
  filename?: string                      // default 'islands.js'
}

interface BuildIslandsResult {
  output: string                         // absolute path of the bundle file
  islands: string[]                      // island names bundled in
  setups: string[]                       // absolute paths of setup.* files applied
}
```

Discovers every `*.vue` file under `inputDir` (recursively) + every `setup*.{ts,js,mts,mjs}` at the root, generates a virtual entry that imports them all, and bundles to a single `islands.js` via `Bun.build` + `vueSfcPlugin()`.

**Island naming.** `resources/ts/islands/LeadKanban.vue` → island name `LeadKanban`. Nested files use a dotted form: `resources/ts/islands/charts/Bar.vue` → `charts.Bar`. The `@island('charts.Bar', { ... })` directive then references the nested island. Duplicates throw `TemplateError`.

**Setup discovery.** Any file at `<inputDir>/setup.{ts,js,mts,mjs}` or `<inputDir>/setup.<anything>.{ts,js,mts,mjs}` is treated as a setup file. Setup files export a default function that runs on the shared app:

```ts
// resources/ts/islands/setup.ts
import type { App } from 'vue'
import { createPinia } from 'pinia'

export default (app: App) => {
  app.use(createPinia())
}
```

Multiple setup files apply in alphabetical order — useful when a router setup depends on a Pinia store being available first (`setup.pinia.ts` runs before `setup.router.ts`).

**Peer deps.** `vue` ^3.5 + `@vue/compiler-sfc` ^3.5 are required peers on `@strav/view` — the realistic shape is "every app has some interactivity," so islands work out of the box without an extra install step. Spring's `--web` template wires them up automatically.

**`external`.** Pass `external: ['vue']` to keep Vue out of the bundle (load from a CDN instead). Default: Vue inlined into `islands.js` so a single download serves the whole page.

**Self-mounting contract** — what `islands.js` does at runtime:

```js
import { createApp, defineComponent, h, Teleport } from 'vue'
import __setup_0 from '<setup.ts>'
import __c0 from '<island0.vue>'
import __c1 from '<island1.vue>'

const __setups = [__setup_0]
const __components = { 'Name0': __c0, 'Name1': __c1 }

function mount() {
  const targets = []
  for (const el of document.querySelectorAll('[data-island]')) {
    const Component = __components[el.getAttribute('data-island')]
    if (!Component) continue
    const props = JSON.parse(el.getAttribute('data-props') || '{}')
    targets.push({ Component, props, el })
  }
  if (targets.length === 0) return

  const Root = defineComponent({
    render() {
      return targets.map((t) => h(Teleport, { to: t.el }, [h(t.Component, t.props)]))
    },
  })
  const app = createApp(Root)
  for (const setup of __setups) setup(app)
  // Mount onto a hidden root — the Teleports do the real placement.
  const root = document.createElement('div')
  root.style.display = 'contents'
  document.body.appendChild(root)
  app.mount(root)
}
```

Apps that prefer a different bundler (vite, esbuild, custom plugin) match this contract themselves.

## Shared state across islands

Because every island lives in the same Vue app context, plugins applied in `setup.ts` propagate everywhere:

```ts
// resources/ts/islands/setup.ts
import type { App } from 'vue'
import { createPinia } from 'pinia'

export default (app: App) => {
  app.use(createPinia())
}
```

```ts
// resources/ts/islands/stores/editor.ts
import { defineStore } from 'pinia'

export const useEditorStore = defineStore('editor', {
  state: () => ({ selectedBlockId: null as string | null, isDirty: false }),
  actions: {
    select(id: string) { this.selectedBlockId = id },
    markDirty() { this.isDirty = true },
  },
})
```

```vue
<!-- resources/ts/islands/Palette.vue -->
<script setup lang="ts">
import { useEditorStore } from './stores/editor'
const editor = useEditorStore()
</script>
<template>
  <button :disabled="!editor.selectedBlockId" @click="editor.markDirty()">
    Edit selected
  </button>
</template>
```

```vue
<!-- resources/ts/islands/Canvas.vue -->
<script setup lang="ts">
import { useEditorStore } from './stores/editor'
const editor = useEditorStore()
</script>
<template>
  <div :class="{ dirty: editor.isDirty }">
    <button v-for="b in blocks" :key="b.id" @click="editor.select(b.id)">{{ b.title }}</button>
  </div>
</template>
```

```strav
{{-- pages/editor.strav --}}
@island('Palette')
@island('Canvas', { blocks })
```

Selecting a block in `Canvas.vue` updates `editor.selectedBlockId`; the `Palette.vue` button reactively enables. One Pinia store, one Vue app context, shared across `@island` directives on the same page.

## `vueSfcPlugin()`

```ts
function vueSfcPlugin(): BunPlugin
```

The Bun plugin used by `buildIslands`. Compiles `.vue` files via `@vue/compiler-sfc`. Exposed for apps that want to call `Bun.build` themselves with the plugin (e.g. to bundle a non-island Vue tree, or to ship multiple separate island bundles for very large apps).

Supports:
- `<script setup>` (inline-template path).
- Options API (`<script>` + `<template>`).
- Scoped + unscoped `<style>` blocks.

Doesn't support:
- HMR (build-time only).
- CSS Modules.
- Custom SFC blocks (`<docs>`, `<i18n>`, …).

## `AssetManifest`

```ts
class AssetManifest {
  constructor(opts?: AssetManifestOptions)
  version(path: string): string
  reload(): void
  load(): Promise<void>
}

interface AssetManifestOptions {
  publicDir?: string   // default 'public'
  manifest?: string    // default '<publicDir>/manifest.json'
  prefix?: string      // default '/'
}
```

The implementation behind `@asset(path)`. Two modes:

- **Manifest mode** — when `manifest` is present, looks up `path` in the JSON. Accepts both `{ "x": "y" }` (Strav-flat) and `{ "x": { "file": "y" } }` (Vite) shapes.
- **Dev fallback** — when no manifest exists, appends `?v=<mtime-hash>` for files that exist under `publicDir`. URLs that don't resolve to a file pass through with just the prefix.

URLs that look absolute (`https://…`, `//cdn.example.com/…`) pass through unchanged. Resolutions are cached per-call; `reload()` drops both the cache and the parsed manifest (the `view:clear` command calls this).

Use directly to share the same manifest across an app — `inject(AssetManifest)` if you've registered it in the container.

## `DiskCache`

```ts
class DiskCache {
  constructor(directory: string)
  readonly directory: string
  keyFor(name: string, source: string): string
  read(name: string, source: string): Promise<CompilationResult | undefined>
  write(name: string, source: string, compiled: CompilationResult): Promise<void>
  clear(): Promise<void>
}
```

Persists compiled templates between process boots. The on-disk key is `<hash>.json` where the hash covers `name` + source — any template edit auto-invalidates the entry. Storage shape:

```json
{ "name": "pages.dashboard", "layout": "layouts.app", "source": "async function __render…" }
```

Read failures (corrupt JSON, missing file, bad source) return `undefined`. Write failures (read-only fs, perms) are swallowed. Disk cache is a speed-up, not a correctness layer — `ViewEngine` always falls back to in-process tokenize + compile.

`ViewEngine` constructs one automatically when `config.view.cache` and `config.view.diskCache` are enabled; you only construct one directly to build out-of-band tooling (e.g. a CI step that pre-warms the cache).

## What this doesn't ship yet

The engine + islands + disk cache + asset versioning cover everything the framework owns. Still to land:

- **Real `@csrf` / `@method` / `@route` wiring** — currently stubs; wires when `@strav/http`'s session middleware + named-route map are accessible to the engine.
- **Response-cache middleware** — caching the rendered HTML for a route (not the compiled template) lives in `@strav/http` / `@strav/cache`, not `@strav/view`.
