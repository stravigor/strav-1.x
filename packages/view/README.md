# @strav/view

The `.strav` template engine for Strav 1.0. Slice 1 ships the engine core: tokenizer + compiler + `ViewEngine` + `ViewProvider` + the full frozen directive set MINUS `@island`.

> **Status:** 1.0.0-alpha — engine core shipped. `@island` + Vue bundler + client runtime + pages auto-router + `view:cache` / `view:build` console commands land in subsequent slices.

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

## What's NOT here yet

- `@island` directive + Vue bundler + client hydration runtime.
- Pages auto-routing (`resources/views/pages/**/*.strav` → routes).
- Disk cache + `view:cache` / `view:build` commands (wait on `@strav/cli`).
- Real `@csrf` / `@route` / `@asset` wiring (stubs today).

Full reference: [`docs/view/api.md`](../../docs/view/api.md).
