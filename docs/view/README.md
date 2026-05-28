# @strav/view

The `.strav` template engine for Strav 1.0. Slice 1 ships the core: a tokenizer, a compiler that emits a callable render function, and a `ViewEngine` runtime with `@extends` / `@section` / `@yield` / `@include` / `@push` / `@stack` / `@component` / `@csrf` / `@method` / `@route` / `@asset` / `@escape` / `@raw` / `@if` / `@for` / `@each` / `@empty` directives.

> **Status: 1.0.0-alpha — engine core shipped.** The frozen directive set is implemented EXCEPT `@island`, which lands in the next view slice along with the Vue bundler + client hydration runtime. Pages auto-routing + the `view:cache` / `view:build` console commands are also deferred (the latter wait on `@strav/cli` in M4).

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
@island                           [reserved for the next slice]
```

`{{ expr }}` is escaped interpolation. `{!! expr !!}` is raw — use only for trusted HTML. `{{-- comment --}}` is a comment (consumed, not rendered).

## What's NOT here yet

- **`@island`** — directive emit + Vue bundler + client hydration runtime. Lands in the next view slice. The compiler throws `TemplateError` if you use `@island` today.
- **Pages auto-routing** — `resources/views/pages/**/*.strav` → file-based `GET` routes. Lands as a separate slice; until then, register routes explicitly.
- **Disk cache + `view:cache` / `view:build` commands** — these wait on `@strav/cli` (M4). The in-memory cache (`config.view.cache`) is the only cache layer today.
- **Real `route()` / `asset()` helpers** — stubbed; `route()` returns the route name verbatim, `asset()` passes through. Real implementations wire when `@strav/http`'s Router and the bundler land.

## Documentation

- [`api.md`](./api.md) — every public export with signatures, semantics, and per-directive notes.
