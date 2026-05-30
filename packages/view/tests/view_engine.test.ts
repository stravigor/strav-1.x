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

  test("@yield('name', 'default') uses the literal default when the child didn't set the section", async () => {
    const engine = makeEngine({
      '/views/layouts/app.strav': "<title>@yield('title', 'albastr')</title>",
      '/views/pages/p.strav': "@extends('layouts.app')",
    })
    expect(await engine.render('pages.p')).toBe('<title>albastr</title>')
  })

  test("@yield('name', 'default') — child @section overrides the default", async () => {
    const engine = makeEngine({
      '/views/layouts/app.strav': "<title>@yield('title', 'albastr')</title>",
      '/views/pages/p.strav':
        "@extends('layouts.app')\n@section('title')Dashboard@endsection",
    })
    expect(await engine.render('pages.p')).toBe('<title>Dashboard</title>')
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

  test('@asset is prefixed by the AssetManifest (no manifest, no public file → bare prefix)', async () => {
    // Default `AssetManifest` resolves `css/app.css` → `/css/app.css`
    // when no manifest exists and the file isn't on disk.
    expect(await engine.render('asset')).toBe('/css/app.css')
  })

  test('@islands emits a script tag pointing at islands/islands.js by default', async () => {
    const e = new ViewEngine({
      config: { directory: '/views', assets: false },
      read: async () => '@islands',
    })
    expect(await e.render('any')).toBe(
      '<script type="module" src="islands/islands.js" defer></script>',
    )
  })

  test('@islands() honors config.view.islands.scriptPath', async () => {
    const e = new ViewEngine({
      config: {
        directory: '/views',
        assets: false,
        islands: { scriptPath: 'bundles/main.js' },
      },
      read: async () => '@islands()',
    })
    expect(await e.render('any')).toBe(
      '<script type="module" src="bundles/main.js" defer></script>',
    )
  })

  test('@islands routes through the AssetManifest (versioned)', async () => {
    const e = new ViewEngine({
      config: { directory: '/views' },
      read: async () => '@islands',
    })
    // No manifest, no on-disk file → default `/islands/islands.js` prefix.
    const html = await e.render('any')
    expect(html).toBe('<script type="module" src="/islands/islands.js" defer></script>')
  })

  test('@css emits a stylesheet link pointing at app.css by default', async () => {
    const e = new ViewEngine({
      config: { directory: '/views', assets: false },
      read: async () => '@css',
    })
    expect(await e.render('any')).toBe('<link rel="stylesheet" href="app.css">')
  })

  test("@css emits all entries when css.inputs is a string array (order preserved)", async () => {
    const e = new ViewEngine({
      config: {
        directory: '/views',
        assets: false,
        css: { inputs: ['resources/css/app.css', 'resources/css/admin.css'] },
      },
      read: async () => '@css',
    })
    expect(await e.render('any')).toBe(
      '<link rel="stylesheet" href="app.css"><link rel="stylesheet" href="admin.css">',
    )
  })

  test("@css('name') emits only the named entry (record-shape inputs)", async () => {
    const e = new ViewEngine({
      config: {
        directory: '/views',
        assets: false,
        css: {
          inputs: {
            main: 'resources/css/app.css',
            admin: 'resources/css/admin.css',
            critical: 'resources/css/critical.css',
          },
        },
      },
      read: async () => "@css('admin')",
    })
    expect(await e.render('any')).toBe('<link rel="stylesheet" href="admin.css">')
  })

  test("@css('unknown-name') emits nothing (silent miss)", async () => {
    const e = new ViewEngine({
      config: {
        directory: '/views',
        assets: false,
        css: { inputs: { main: 'resources/css/app.css' } },
      },
      read: async () => "A@css('nope')B",
    })
    expect(await e.render('any')).toBe('AB')
  })

  test('@css() returns empty when css.linkPath is null', async () => {
    const e = new ViewEngine({
      config: { directory: '/views', assets: false, css: { linkPath: null } },
      read: async () => 'A@css()B',
    })
    expect(await e.render('any')).toBe('AB')
  })

  test('@asset is a pass-through when assets: false', async () => {
    const e2 = new ViewEngine({
      config: { directory: '/views', assets: false },
      read: async () => "@asset('css/app.css')",
    })
    expect(await e2.render('asset')).toBe('css/app.css')
  })
})

// ─── clearCache + warmCache ─────────────────────────────────────────────────

describe('ViewEngine — clearCache + warmCache', () => {
  test('clearCache() drops every cached compilation', async () => {
    let reads = 0
    const engine = new ViewEngine({
      config: { directory: '/views', cache: true },
      read: async (path) => {
        reads++
        if (path === '/views/home.strav') return '<h1>Home</h1>'
        throw new Error(`ENOENT: ${path}`)
      },
    })
    await engine.render('home') // compiles + caches
    await engine.render('home') // cache hit → reads still 1
    expect(reads).toBe(1)

    engine.clearCache()
    await engine.render('home') // re-compile → reads = 2
    expect(reads).toBe(2)
  })

  test('warmCache() pre-compiles every *.strav found by glob', async () => {
    // Use a tmp dir with real .strav files to exercise the glob.
    const { mkdir, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const tmpDir = join(tmpdir(), `view-warm-${Date.now()}`)
    await mkdir(tmpDir)
    await writeFile(join(tmpDir, 'layout.strav'), '<html>@yield("main")</html>')
    await writeFile(
      join(tmpDir, 'home.strav'),
      '@extends("layout") @section("main") Hi @endsection',
    )

    const warmEngine = new ViewEngine({ config: { directory: tmpDir, cache: true } })
    const { warmed, errors } = await warmEngine.warmCache()

    expect(errors).toHaveLength(0)
    const names = new Set(warmed)
    expect(names.has('layout')).toBe(true)
    expect(names.has('home')).toBe(true)

    await rm(tmpDir, { recursive: true, force: true })
  })
})
