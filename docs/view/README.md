# @strav/view

The `.strav` template engine for Strav 1.0. The full frozen directive set is implemented: `@if` / `@for` / `@each` / `@extends` / `@section` / `@yield` / `@include` / `@push` / `@stack` / `@csrf` / `@method` / `@route` / `@asset` / `@raw` / `@escape` / `@component` — plus `@island` for Vue 3 hydration islands. A programmatic Vue SFC bundler (`buildIslands`) compiles each island into a self-mounting browser bundle.

> **Status: 1.0.0-alpha.10 — engine + islands + pages auto-router + console commands shipped.** `resources/views/pages/**/*.strav` files are automatically registered as GET routes by `ViewProvider.boot()`. See `docs/view/guides/pages.md`.

## Install

```bash
bun add @strav/view
```

Peer: `@strav/kernel`.

## What's here

| Symbol | Purpose |
|---|---|
| `tokenize(source)` / `Token` / `TokenType` | The lexer. Exposed for debug tools + tests; user code rarely calls it directly |
| `compile(tokens)` / `CompilationResult` / `RenderFunction` / `RenderContext` / `RenderResult` | Compiles tokens to a callable render function. Implements every frozen directive except `@island` |
| `escapeHtml(value)` | HTML entity escape — what `{{ expr }}` and `@escape(value)` use |
| `ViewEngine` / `ViewConfig` / `ViewEngineOptions` | The public runtime — resolves dotted names → `.strav` paths, compiles, caches, walks the layout chain |
| `ViewProvider` | Wires `ViewEngine` + the `'view'` alias from `config('view')` |
| `TemplateError` | Typed `StravError` for tokenize / compile / render failures |
| `buildIslands(opts)` / `BuildIslandsOptions` / `BuildIslandsResult` | Programmatic Vue SFC bundler — discovers `*.vue` under `inputDir`, emits a self-mounting `<Name>.js` per island in `outputDir` |
| `vueSfcPlugin()` | The Bun bundler plugin behind `buildIslands` — exposed so apps can call `Bun.build` themselves |

## Minimal example

`resources/views/pages/dashboard.strav`:

```strav
@extends('layouts.app')

@set('title', 'Dashboard')

@section('content')
  <h1>Hello, {{ user.name }}</h1>
  @each(item in items)
    <li>{{ item.title }}</li>
  @empty
    <li>No items yet.</li>
  @endeach
@endsection
```

`resources/views/layouts/app.strav`:

```strav
<!DOCTYPE html>
<html>
  <head>
    <title>@yield('title')</title>
    @stack('head')
  </head>
  <body>
    <main>@yield('content')</main>
  </body>
</html>
```

`config/view.ts`:

```ts
import type { ViewConfig } from '@strav/view'

export default {
  directory: 'resources/views',
  cache: process.env.NODE_ENV !== 'development',
  globals: { app: { name: 'Acme' } },
} satisfies ViewConfig
```

Render:

```ts
import { inject } from '@strav/kernel'
import { ViewEngine } from '@strav/view'

@inject()
class DashboardController {
  constructor(private readonly view: ViewEngine) {}

  async show(): Promise<string> {
    return this.view.render('pages.dashboard', {
      user: { name: 'Alice' },
      items: [{ title: 'first' }, { title: 'second' }],
    })
  }
}
```

`view.render('pages.dashboard', data)` resolves the dotted name to `{directory}/pages/dashboard.strav`, tokenizes + compiles on first hit (then caches), walks any `@extends` chain, and returns the final HTML.

## Directive catalog

The directive set is **frozen** for 1.0 — new directives need an RFC. See [`api.md`](./api.md) for the full reference with semantics per directive.

```
@if @elseif @else @endif
@for @endfor
@each @empty @endeach
@extends
@section @endsection @set @yield
@include
@push @endpush @prepend @endprepend @stack
@csrf
@method
@route
@asset
@raw @endraw
@escape
@component @endcomponent
@island
```

`{{ expr }}` is escaped interpolation. `{!! expr !!}` is raw — use only for trusted HTML. `{{-- comment --}}` is a comment (consumed, not rendered).

## Islands — Vue 3 hydration with shared state

ONE Vue app per page, MANY islands via `<Teleport>`. Every island shares the same app context, so a Pinia store registered in `setup.ts` is reactive across all islands on the page.

```strav
{{-- resources/views/pages/editor.strav --}}
@island('Palette')
@island('Canvas', { blocks })
```

```ts
// resources/ts/islands/setup.ts — runs ONCE on the shared app
import type { App } from 'vue'
import { createPinia } from 'pinia'
export default (app: App) => { app.use(createPinia()) }
```

```ts
// resources/ts/islands/stores/editor.ts
import { defineStore } from 'pinia'
export const useEditorStore = defineStore('editor', {
  state: () => ({ selectedBlockId: null as string | null }),
  actions: { select(id: string) { this.selectedBlockId = id } },
})
```

```vue
<!-- resources/ts/islands/Palette.vue -->
<script setup>
import { useEditorStore } from './stores/editor'
const editor = useEditorStore()
</script>
<template>
  <button :disabled="!editor.selectedBlockId">Edit selected</button>
</template>
```

At build time:

```ts
import { buildIslands } from '@strav/view'

await buildIslands({
  inputDir: 'resources/ts/islands',
  outputDir: 'public/assets/islands',
})
```

Outputs ONE `public/assets/islands/islands.js` containing every island + every `setup.*` hook. Apps include it in their layout:

```strav
{{-- resources/views/layouts/app.strav --}}
<head>
  <script type="module" src="@asset('islands/islands.js')" defer></script>
</head>
```

Optional peer deps:

```bash
bun add vue @vue/compiler-sfc
```

Apps that prefer their own bundler match the [single-bundle contract](./api.md#buildislandsopts) themselves.

## What's NOT here yet

- **Disk cache** — persist compiled templates across process restarts (in-memory cache resets on each boot today).
- **Disk cache + `view:cache` / `view:build` commands** — these wait on `@strav/cli` (M4). The in-memory cache (`config.view.cache`) is the only cache layer today; `buildIslands` is the programmatic equivalent of `view:build`.
- **Real `route()` / `asset()` helpers** — stubbed; `route()` returns the route name verbatim, `asset()` passes through. Real implementations wire when `@strav/http`'s Router and asset versioning land.

## Documentation

- [`api.md`](./api.md) — every public export with signatures, semantics, and per-directive notes.
