import { beforeEach, describe, expect, test } from 'bun:test'
import { TemplateError, ViewEngine } from '../src/index.ts'

// ─── Helpers ────────────────────────────────────────────────────────────────

interface InMemoryFiles {
  [path: string]: string
}

function makeEngine(
  files: InMemoryFiles,
  config: { directory?: string; cache?: boolean; globals?: Record<string, unknown> } = {},
): ViewEngine {
  return new ViewEngine({
    config: { directory: '/views', ...config },
    read: async (path: string) => {
      if (path in files) return files[path] as string
      throw new Error(`ENOENT: ${path}`)
    },
  })
}

// ─── Render ─────────────────────────────────────────────────────────────────

describe('ViewEngine — render', () => {
  test('resolves dotted names to .strav paths under directory', async () => {
    const engine = makeEngine({
      '/views/pages/dashboard.strav': '<h1>{{ title }}</h1>',
    })
    const html = await engine.render('pages.dashboard', { title: 'Hi' })
    expect(html).toBe('<h1>Hi</h1>')
  })

  test('missing template throws TemplateError', async () => {
    const engine = makeEngine({})
    await expect(engine.render('pages.missing')).rejects.toThrow(TemplateError)
  })

  test('globals merge under per-call data (data wins on collision)', async () => {
    const engine = makeEngine(
      { '/views/page.strav': '{{ app }}|{{ user }}' },
      { globals: { app: 'Strav', user: 'global-user' } },
    )
    expect(await engine.render('page', { user: 'request-user' })).toBe('Strav|request-user')
  })

  test('cache hits — second render does not re-read the source', async () => {
    let reads = 0
    const engine = new ViewEngine({
      config: { directory: '/views', cache: true },
      read: async (path) => {
        reads += 1
        if (path === '/views/page.strav') return 'plain'
        throw new Error('not found')
      },
    })
    await engine.render('page')
    await engine.render('page')
    expect(reads).toBe(1)
  })

  test('cache disabled — re-reads each time', async () => {
    let reads = 0
    const engine = new ViewEngine({
      config: { directory: '/views', cache: false },
      read: async () => {
        reads += 1
        return 'plain'
      },
    })
    await engine.render('page')
    await engine.render('page')
    expect(reads).toBe(2)
  })

  test('paths that resolve outside the views dir are rejected', async () => {
    const engine = makeEngine({})
    await expect(engine.render('../etc.passwd')).rejects.toThrow(/resolves outside/)
  })
})

// ─── Layout chain ───────────────────────────────────────────────────────────

describe('ViewEngine — @extends + @section + @yield', () => {
  test('child @section feeds parent @yield', async () => {
    const engine = makeEngine({
      '/views/layouts/app.strav': "<title>@yield('title')</title><main>@yield('content')</main>",
      '/views/pages/dashboard.strav': `@extends('layouts.app')
@set('title', 'Dashboard')
@section('content')<h1>{{ greeting }}</h1>@endsection`,
    })
    const html = await engine.render('pages.dashboard', { greeting: 'Hi' })
    expect(html).toBe('<title>Dashboard</title><main><h1>Hi</h1></main>')
  })

  test('nested layout chain (child → parent → grandparent)', async () => {
    const engine = makeEngine({
      '/views/layouts/base.strav': "<base>@yield('body')</base>",
      '/views/layouts/app.strav':
        "@extends('layouts.base')\n@section('body')[app:@yield('content')]@endsection",
      '/views/pages/p.strav': "@extends('layouts.app')\n@section('content')X@endsection",
    })
    const html = await engine.render('pages.p')
    expect(html).toBe('<base>[app:X]</base>')
  })
})

// ─── Includes ───────────────────────────────────────────────────────────────

describe('ViewEngine — @include', () => {
  test('include resolves and renders with merged data', async () => {
    const engine = makeEngine({
      '/views/partials/alert.strav': '<div class="{{ kind }}">{{ text }}</div>',
      '/views/page.strav': "@include('partials.alert', { kind: 'success', text: 'Saved' })",
    })
    expect(await engine.render('page')).toBe('<div class="success">Saved</div>')
  })

  test('include carries the section pool — child @push reaches a LATER @stack', async () => {
    const engine = makeEngine({
      '/views/partials/widget.strav': "@push('head')<style>x</style>@endpush",
      // @include precedes @stack so the push lands before @stack reads.
      '/views/page.strav': "<body>@include('partials.widget')</body><tail>@stack('head')</tail>",
    })
    const html = await engine.render('page')
    expect(html).toBe('<body></body><tail><style>x</style></tail>')
  })

  test('circular @include — depth limit triggers', async () => {
    const engine = makeEngine({
      '/views/a.strav': "@include('b')",
      '/views/b.strav': "@include('a')",
    })
    await expect(engine.render('a')).rejects.toThrow(/depth exceeded/)
  })
})

// ─── @push / @stack within the same template ───────────────────────────────

describe('ViewEngine — stacks across the layout chain', () => {
  test('child @push reaches the layout @stack', async () => {
    const engine = makeEngine({
      '/views/layouts/app.strav': "<head>@stack('head')</head><body>@yield('content')</body>",
      '/views/page.strav': `@extends('layouts.app')
@push('head')<link rel="stylesheet">@endpush
@section('content')<p>page</p>@endsection`,
    })
    const html = await engine.render('page')
    expect(html).toContain('<head><link rel="stylesheet"></head>')
    expect(html).toContain('<body>')
    expect(html).toContain('<p>page</p>')
  })

  test('@prepend runs before @push', async () => {
    const engine = makeEngine({
      '/views/layouts/app.strav': "@stack('s')",
      '/views/page.strav': `@extends('layouts.app')
@push('s')B@endpush
@prepend('s')A@endprepend`,
    })
    expect(await engine.render('page')).toBe('AB')
  })
})

// ─── Standard globals (stubs) ───────────────────────────────────────────────

describe('ViewEngine — standard helpers', () => {
  let engine: ViewEngine

  beforeEach(() => {
    engine = makeEngine({
      '/views/csrf.strav': '@csrf',
      '/views/method.strav': "@method('PUT')",
      '/views/route.strav': "@route('users.show')",
      '/views/asset.strav': "@asset('css/app.css')",
    })
  })

  test('@csrf renders a stub hidden input', async () => {
    const html = await engine.render('csrf')
    expect(html).toBe('<input type="hidden" name="_token" value="">')
  })

  test('@method renders a stub hidden input with the verb upcased', async () => {
    expect(await engine.render('method')).toBe('<input type="hidden" name="_method" value="PUT">')
  })

  test('@route stub returns the name verbatim until @strav/http wires the real Router', async () => {
    expect(await engine.render('route')).toContain('users.show')
  })

  test('@asset passes through (asset versioning lands with the bundler slice)', async () => {
    expect(await engine.render('asset')).toBe('css/app.css')
  })
})
