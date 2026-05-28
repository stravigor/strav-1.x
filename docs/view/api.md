# @strav/view — API Reference

> **Status:** Engine + islands shipped. The frozen directive set is implemented in full (including `@island`); a Vue SFC bundler (`buildIslands`) compiles each island into a self-mounting browser bundle. Pages auto-router + `view:cache` / `view:build` console commands deferred (the latter wait on `@strav/cli` in M4).

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
}

interface ViewConfig {
  directory?: string                                // default 'resources/views'
  cache?: boolean                                   // default true
  globals?: Record<string, unknown>                 // merged into every render's data
  islandsUrl?: string                               // default '/assets/islands' — base URL @island uses for <script src>
}

interface ViewEngineOptions {
  config: ViewConfig
  read?: (absolutePath: string) => Promise<string>  // injected for tests
}
```

**Name resolution.** `view.render('pages.dashboard', ...)` → `{directory}/pages/dashboard.strav`. Dots in the name become path separators. Names that resolve outside the configured `directory` throw `TemplateError` — defence against template-name path traversal.

**Compilation + cache.** Tokenise + compile on first hit; cache the render function in memory keyed by template name. Disable the cache for dev (`config.view.cache = false`) so edits take effect without restart.

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

Asset URL helper. Slice 1 returns the input path verbatim. Real implementation (versioning + bundle integration) lands with the view-build slice.

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

Compiles to:

```html
<div data-island="LeadKanban" data-props="{...escaped JSON...}"></div>
<script type="module" src="/assets/islands/LeadKanban.js" defer></script>
```

The per-island `<script type="module">` bundle is produced by `buildIslands` (or by an app's own bundler — see "Bundler contract" below). When loaded, the bundle finds every `[data-island="LeadKanban"]` in the DOM, parses `data-props`, and mounts a Vue 3 app onto the element.

**Props serialisation.** Props are JSON-stringified then HTML-attr-escaped. Anything that survives `JSON.stringify` round-trips cleanly (`Date` becomes a string, `undefined` is dropped, etc.). For non-serialisable state, fetch it client-side from inside the Vue component.

**Custom `islandsUrl`.** Set `config.view.islandsUrl` to override the script `src` base — e.g. `'https://cdn.example.com/islands'` for CDN-hosted bundles.

**Loading semantics.** The `defer` attribute on the module script makes it execute after HTML parsing finishes; combined with `type="module"`, browsers fetch + parse in parallel and run in order. The bundle's self-mounting code calls `document.querySelectorAll` so each `<script>` mounts its own islands — page reloads work naturally.

## `buildIslands(opts)`

```ts
function buildIslands(opts: BuildIslandsOptions): Promise<BuildIslandsResult>

interface BuildIslandsOptions {
  inputDir: string                       // resources/ts/islands
  outputDir: string                      // public/assets/islands
  minify?: boolean                       // default true
  sourcemap?: boolean                    // default false (inline when true)
  external?: string[]                    // e.g. ['vue'] to load Vue from CDN
}

interface BuildIslandsResult {
  outputs: string[]                      // absolute paths of <Name>.js files
  islands: string[]                      // island names that were bundled
}
```

Discovers every `*.vue` file under `inputDir` (recursively), generates a self-mounting entry per island, and bundles each with `Bun.build` + the bundled `vueSfcPlugin()`. Output: one `<Name>.js` per island in `outputDir`.

**Island naming.** `resources/ts/islands/LeadKanban.vue` → island name `LeadKanban`. Nested files use a dotted form: `resources/ts/islands/charts/Bar.vue` → `charts.Bar`. The `@island('charts.Bar', { ... })` directive then references the nested bundle. Duplicates throw `TemplateError`.

**Optional peer deps.** `vue` + `@vue/compiler-sfc` are declared as `peerDependenciesMeta.optional` on `@strav/view`. Apps that don't use islands never install them; apps that do, install both alongside `@strav/view`.

**`external`.** Pass `external: ['vue']` to keep Vue out of every per-island bundle — useful when serving Vue from a CDN. The default inlines Vue into each bundle (every island bundle ships its own copy ~50KB compressed; trade-off vs. one Vue request per page).

**Self-mounting contract** — what each `<Name>.js` does at runtime:

```js
import { createApp } from 'vue'
import Component from './<Name>.vue'

function hydrate() {
  for (const el of document.querySelectorAll('[data-island="<Name>"]')) {
    const raw = el.getAttribute('data-props')
    const props = raw === null ? {} : (() => { try { return JSON.parse(raw) } catch { return {} } })()
    createApp(Component, props).mount(el)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hydrate, { once: true })
} else {
  hydrate()
}
```

Apps that prefer a different bundler (vite, esbuild, custom Bun plugin) skip `buildIslands` and bring their own — as long as each `<outputDir>/<Name>.js` matches this contract.

## `vueSfcPlugin()`

```ts
function vueSfcPlugin(): BunPlugin
```

The Bun plugin used by `buildIslands`. Compiles `.vue` files via `@vue/compiler-sfc`. Exposed for apps that want to call `Bun.build` themselves with the plugin (e.g. to bundle a non-island Vue tree).

Supports:
- `<script setup>` (inline-template path).
- Options API (`<script>` + `<template>`).
- Scoped + unscoped `<style>` blocks.

Doesn't support:
- HMR (build-time only).
- CSS Modules.
- Custom SFC blocks (`<docs>`, `<i18n>`, …).

## What this doesn't ship yet

The engine + islands cover server-rendered templates with client-hydratable Vue pockets. Still to land:

- **Pages auto-router** — `resources/views/pages/**/*.strav` → file-based `GET` routes, with `[slug]` + `[...rest]` segments, leading-underscore exclusion, and static-beats-dynamic precedence.
- **Disk cache + `view:cache` console command** — precompiles every template at deploy time for one-disk-read production boot.
- **`view:build` command** — same as `buildIslands` but driven by `@strav/cli`. Programmatic API exists today.
- **Asset versioning** — real `asset()` URLs with content-hash query strings.
- **Real `@csrf` / `@method` / `@route` wiring** — currently stubs; wires when `@strav/http`'s session middleware + named-route map are accessible to the engine.
