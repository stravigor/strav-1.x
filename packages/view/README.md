# @strav/view

The `.strav` template engine for Strav 1.0. Full frozen directive set + Vue 3 hydration islands via `@island`. Tokenizer + compiler + `ViewEngine` + `ViewProvider` + programmatic `buildIslands` bundler.

> **Status:** 1.0.0-alpha — engine + islands shipped. Pages auto-router + `view:cache` / `view:build` console commands land in subsequent slices.

## Install

```bash
bun add @strav/view
```

Peer: `@strav/kernel`.

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

```bash
bun add vue @vue/compiler-sfc    # optional peer deps
```

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

## What's NOT here yet

- Pages auto-routing (`resources/views/pages/**/*.strav` → routes).
- Disk cache + `view:cache` / `view:build` console commands (programmatic `buildIslands` ships today; CLI wrappers wait on `@strav/cli`).
- Real `@csrf` / `@route` / `@asset` wiring (stubs today).

Full reference: [`docs/view/api.md`](../../docs/view/api.md).
