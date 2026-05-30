# @strav/view

The `.strav` template engine for Strav 1.0. Full frozen directive set + Vue 3 hydration islands via `@island`. Tokenizer + compiler + `ViewEngine` + `ViewProvider` + programmatic `buildIslands` bundler.

> **Status:** Feature-complete for 1.0 — engine + islands + pages auto-router + console commands (`view:cache` / `view:clear` / `view:build`) + disk cache + asset versioning all shipped.

## Install

```bash
bun add @strav/view
```

Peers: `@strav/kernel`, `vue` ^3.5, `@vue/compiler-sfc` ^3.5.

## Quick start

```ts
// config/view.ts
import type { ViewConfig } from '@strav/view'

export default {
  directory: 'resources/views',
  cache: process.env.NODE_ENV !== 'development',
} satisfies ViewConfig
```

```ts
// In a controller / service:
@inject()
class DashboardController {
  constructor(private readonly view: ViewEngine) {}

  async show(): Promise<string> {
    return this.view.render('pages.dashboard', { user, items })
  }
}
```

```strav
{{-- resources/views/pages/dashboard.strav --}}
@extends('layouts.app')

@set('title', 'Dashboard')

@section('content')
  <h1>Hi {{ user.name }}</h1>
  @each(item in items)
    <li>{{ item.title }}</li>
  @empty
    <li>No items.</li>
  @endeach
@endsection
```

Render:

```ts
const html = await view.render('pages.dashboard', { user, items })
```

## Islands — shared Vue app context

```strav
@island('Palette')
@island('Canvas', { blocks })
```

```ts
// resources/ts/islands/setup.ts — runs once on the shared app
import { createPinia } from 'pinia'
export default (app) => { app.use(createPinia()) }
```

```ts
import { buildIslands } from '@strav/view'

await buildIslands({
  inputDir: 'resources/ts/islands',
  outputDir: 'public/assets/islands',
})
```

Outputs ONE `islands.js` containing every island + setup hook. Apps include the script in their layout:

```strav
<script type="module" src="@asset('islands/islands.js')" defer></script>
```

All islands run inside the same `createApp(Root)` — Pinia stores shared, plugins applied once. See `docs/view/api.md` for the bundler contract + shared-state walkthrough.

## Caching + assets

- Compiled templates are cached in memory AND on disk (`storage/cache/views/`, configurable via `config.view.diskCache`). The disk hash is over template source, so edits auto-invalidate. `bun strav view:clear` wipes both layers.
- `@asset(path)` resolves through an `AssetManifest`: reads a Strav-flat or Vite `manifest.json` if present (under `config.view.assets.publicDir`, default `public/`), falls back to mtime query strings in dev. Set `config.view.assets = false` for pure pass-through.

## What's NOT here yet

- Real `@csrf` / `@route` wiring (stubs today — wires when `@strav/http`'s session middleware and named-route map are accessible to the engine).

Full reference: [`docs/view/api.md`](../../docs/view/api.md).
