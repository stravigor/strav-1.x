# Pages auto-router

`.strav` files placed under `resources/views/pages/` are automatically mapped to HTTP routes — no controller, no explicit route declaration needed.

```
resources/views/pages/
├── index.strav          → GET /
├── about.strav          → GET /about
├── pricing.strav        → GET /pricing
├── blog/
│   ├── index.strav      → GET /blog
│   └── [slug].strav     → GET /blog/:slug
└── docs/
    └── [...path].strav  → GET /docs/*
```

`ViewProvider` registers these routes during `boot()` — before `HttpProvider` compiles the trie — so they participate in the same routing table as your explicit routes.

## File → URL mapping

| File | URL | Notes |
|---|---|---|
| `index.strav` | `/` | Root of a directory collapses to the directory URL |
| `about.strav` | `/about` | |
| `blog/index.strav` | `/blog` | `index` collapses |
| `blog/[slug].strav` | `/blog/:slug` | Dynamic segment |
| `docs/[...path].strav` | `/docs/*` | Wildcard — captures the rest of the path |
| `_partials/cta.strav` | _(skipped)_ | Leading `_` on a file or folder = excluded |

Rules in priority order:

1. **Leading underscore** — any segment starting with `_` is skipped. Use for partials co-located with their page.
2. **`index.strav`** represents the parent directory's URL.
3. **`[name].strav`** → `:name` dynamic param.
4. **`[...name].strav`** → `*` wildcard.
5. **Explicit routes win**: routes registered in `routes/web.ts` always take precedence over auto-routed pages at the same path.

## Template context

Auto-routed pages get the standard template globals plus two extra locals injected by the page handler:

```strav
{{-- resources/views/pages/blog/[slug].strav --}}
@extends('layouts.app')

@section('content')
  <article>
    <h1>{{ params.slug }}</h1>    {{-- URL params --}}
    <p>Page: {{ query.page }}</p> {{-- query string --}}
  </article>
@endsection
```

- **`params`** — captured URL segments (`Record<string, string>`).
- **`query`** — URL query string (`Record<string, string | string[]>`).

Pages have **no data loader**. If a page needs data from the database, convert it to a controller-based route:

```ts
// routes/web.ts
router.get('/blog/:slug', [PostController, 'show'])
```

The clean line between page (static/template-only) and controller (data-driven) is what keeps this feature small.

## Configuration

```ts
// config/view.ts
export default {
  directory: 'resources/views',
  pages: {
    autoRoute: true,                     // default — set false to opt out
    middleware: ['cache:public,1h'],     // applied to EVERY auto-routed page
    pagesDir: 'resources/views/pages',  // override the pages root
  },
}
```

`pages.middleware` is the only per-page knob available through config. For per-page middleware (e.g., one page behind auth), move that page to an explicit route in `routes/web.ts`.

## Disabling auto-routing

Set `config.view.pages.autoRoute = false`:

```ts
// config/view.ts
export default {
  pages: { autoRoute: false },
}
```

Or omit `ViewProvider` from `bootstrap/providers.ts` entirely if you don't use the view layer.

## Using `registerPages` directly

The function is also available to call yourself — useful if you need more control over when or where pages are registered:

```ts
import { registerPages } from '@strav/view'

// Inside a custom provider's boot():
const engine = app.resolve(ViewEngine)
const router = app.resolve(Router)
await registerPages(engine, router, {
  pagesDir: resolve(process.cwd(), 'resources/views/pages'),
  middleware: ['cache:public,1h'],
})
```

## Integration with `route:list`

`bun strav route:list` shows auto-routed pages alongside explicit routes. They appear with the same columns (Method / Path / Name / Middleware) and no special marker — they're just GET routes added by `ViewProvider`.

## Caching

`bun strav view:cache` precompiles every `.strav` template, including pages. The compiled output is stored in the engine's in-memory cache so the first request doesn't pay a compile cost in production.

## When NOT to use a page

| Situation | Use instead |
|---|---|
| Needs data from the DB | Controller-based route |
| Needs POST / PUT / DELETE | Explicit router entry |
| Per-page middleware that differs from `pages.middleware` | Explicit router entry with its own middleware |
| Redirects or complex logic | Controller |

A page that needs database data is a controller. A page that needs custom middleware is a controller. If in doubt, write a controller — they're one `make:controller` away.
