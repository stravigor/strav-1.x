import { describe, expect, test } from 'bun:test'
import {
  compile,
  escapeHtml,
  type RenderContext,
  type RenderResult,
  tokenize,
} from '../src/index.ts'

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  const sections: Record<string, string> = {}
  const stacks: Record<string, string[]> = {}
  return {
    escape: escapeHtml,
    async include() {
      return ''
    },
    section(name, body) {
      sections[name] = body
    },
    setValue(name, value) {
      sections[name] = escapeHtml(value)
    },
    yieldSection(name) {
      return sections[name] ?? ''
    },
    push(name, body) {
      stacks[name] = stacks[name] ?? []
      stacks[name].push(body)
    },
    prepend(name, body) {
      stacks[name] = stacks[name] ?? []
      stacks[name].unshift(body)
    },
    stackOf(name) {
      return (stacks[name] ?? []).join('')
    },
    csrf() {
      return '<csrf>'
    },
    method(verb) {
      return `<method:${verb}>`
    },
    route(name) {
      return `/route/${name}`
    },
    asset(path) {
      return `/asset/${path}`
    },
    async component() {
      return ''
    },
    async island(name, props) {
      return `<island:${name}:${JSON.stringify(props)}>`
    },
    ...overrides,
  }
}

async function compileRender(
  source: string,
  data: Record<string, unknown> = {},
  ctxOverrides: Partial<RenderContext> = {},
): Promise<RenderResult> {
  const tokens = tokenize(source)
  const compiled = compile(tokens)
  return compiled.render(data, renderCtx(ctxOverrides))
}

// ─── Plain text + interpolation ─────────────────────────────────────────────

describe('compile — text + interpolation', () => {
  test('text is emitted verbatim', async () => {
    const r = await compileRender('<h1>Hello</h1>')
    expect(r.html).toBe('<h1>Hello</h1>')
  })

  test('{{ expr }} escapes HTML', async () => {
    const r = await compileRender('<p>{{ name }}</p>', { name: '<script>alert(1)</script>' })
    expect(r.html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  test('{!! expr !!} renders raw', async () => {
    const r = await compileRender('{!! html !!}', { html: '<b>bold</b>' })
    expect(r.html).toBe('<b>bold</b>')
  })

  test('{!! null !!} → empty string (not "null")', async () => {
    const r = await compileRender('{!! x !!}', { x: null })
    expect(r.html).toBe('')
  })
})

// ─── Conditionals ───────────────────────────────────────────────────────────

describe('compile — @if / @elseif / @else / @endif', () => {
  test('truthy branch', async () => {
    const r = await compileRender('@if(ok)yes@endif', { ok: true })
    expect(r.html).toBe('yes')
  })

  test('falsy branch with @else', async () => {
    const r = await compileRender('@if(ok)yes@else no@endif', { ok: false })
    expect(r.html).toBe(' no')
  })

  test('@elseif chain', async () => {
    const src = '@if(n===1)one@elseif(n===2)two@else other@endif'
    expect((await compileRender(src, { n: 1 })).html).toBe('one')
    expect((await compileRender(src, { n: 2 })).html).toBe('two')
    expect((await compileRender(src, { n: 9 })).html).toBe(' other')
  })

  test('unclosed @if throws TemplateError with line info', () => {
    expect(() => compile(tokenize('@if(x) hi'))).toThrow(/Unclosed @if/)
  })

  test('@else without matching @if throws', () => {
    expect(() => compile(tokenize('@else'))).toThrow(/without matching/)
  })
})

// ─── Loops ──────────────────────────────────────────────────────────────────

describe('compile — @for / @endfor', () => {
  test('iterates with destructuring-friendly syntax', async () => {
    const r = await compileRender('@for(x of items){{ x }} @endfor', {
      items: ['a', 'b', 'c'],
    })
    expect(r.html).toBe('a b c ')
  })
})

describe('compile — @each / @empty / @endeach', () => {
  test('non-empty collection iterates', async () => {
    const r = await compileRender('@each(x in items)[{{ x }}]@empty(none)@endeach', {
      items: ['a', 'b'],
    })
    expect(r.html).toBe('[a][b]')
  })

  test('empty collection renders @empty body', async () => {
    // `@empty` takes no args — the body between `@empty` and
    // `@endeach` is the empty-case template.
    const r = await compileRender('@each(x in items)[{{ x }}]@empty (none)@endeach', {
      items: [],
    })
    expect(r.html).toBe(' (none)')
  })

  test('@each without @empty closes correctly', async () => {
    const r = await compileRender('@each(x in items)[{{ x }}]@endeach', {
      items: ['a'],
    })
    expect(r.html).toBe('[a]')
  })

  test('malformed @each args throw', () => {
    expect(() => compile(tokenize('@each(garbage)@endeach'))).toThrow(/@each expects/)
  })
})

// ─── Sections + yield + extends ─────────────────────────────────────────────

describe('compile — @extends / @section / @set / @yield', () => {
  test('@extends sets layout on CompilationResult', () => {
    const c = compile(tokenize("@extends('layouts.app')"))
    expect(c.layout).toBe('layouts.app')
  })

  test('@section writes to the sections pool; @yield reads', async () => {
    const sections: Record<string, string> = {}
    const ctx = renderCtx({
      section(name, body) {
        sections[name] = body
      },
      yieldSection(name) {
        return sections[name] ?? ''
      },
    })
    // Run two separate compilations against the same sections pool —
    // simulates layout chain.
    const child = compile(tokenize("@section('content')<h1>{{ name }}</h1>@endsection"))
    await child.render({ name: 'Alice' }, ctx)
    const parent = compile(tokenize("<main>@yield('content')</main>"))
    const result = await parent.render({}, ctx)
    expect(result.html).toBe('<main><h1>Alice</h1></main>')
  })

  test("@set('title', value) writes an escaped literal to the slot", async () => {
    const sections: Record<string, string> = {}
    const ctx = renderCtx({
      setValue(name, value) {
        sections[name] = escapeHtml(value)
      },
      yieldSection(name) {
        return sections[name] ?? ''
      },
    })
    const child = compile(tokenize("@set('title', name)"))
    await child.render({ name: '<b>Acme</b>' }, ctx)
    const parent = compile(tokenize("<title>@yield('title')</title>"))
    const result = await parent.render({}, ctx)
    expect(result.html).toBe('<title>&lt;b&gt;Acme&lt;/b&gt;</title>')
  })
})

// ─── Stacks ─────────────────────────────────────────────────────────────────

describe('compile — @push / @prepend / @stack', () => {
  test('@push appends; @stack reads', async () => {
    const stacks: Record<string, string[]> = {}
    const ctx = renderCtx({
      push(name, body) {
        stacks[name] = stacks[name] ?? []
        stacks[name].push(body)
      },
      stackOf(name) {
        return (stacks[name] ?? []).join('')
      },
    })
    const child = compile(tokenize("@push('head')<link>@endpush"))
    await child.render({}, ctx)
    const layout = compile(tokenize("<head>@stack('head')</head>"))
    expect((await layout.render({}, ctx)).html).toBe('<head><link></head>')
  })

  test('@prepend goes first', async () => {
    const stacks: Record<string, string[]> = {}
    const ctx = renderCtx({
      push(name, body) {
        stacks[name] = stacks[name] ?? []
        stacks[name].push(body)
      },
      prepend(name, body) {
        stacks[name] = stacks[name] ?? []
        stacks[name].unshift(body)
      },
      stackOf(name) {
        return (stacks[name] ?? []).join('')
      },
    })
    await compile(tokenize("@push('s')B@endpush")).render({}, ctx)
    await compile(tokenize("@prepend('s')A@endprepend")).render({}, ctx)
    const result = await compile(tokenize("@stack('s')")).render({}, ctx)
    expect(result.html).toBe('AB')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────────────

describe('compile — helper directives', () => {
  test('@csrf calls ctx.csrf', async () => {
    expect((await compileRender('@csrf')).html).toBe('<csrf>')
  })
  test('@method(verb)', async () => {
    expect((await compileRender("@method('PUT')")).html).toBe('<method:PUT>')
  })
  test('@route(name)', async () => {
    expect((await compileRender("@route('users.show')")).html).toBe('/route/users.show')
  })
  test('@asset(path)', async () => {
    expect((await compileRender("@asset('css/app.css')")).html).toBe('/asset/css/app.css')
  })
  test('@escape forwards to ctx.escape', async () => {
    const r = await compileRender('@escape(name)', { name: '<x>' })
    expect(r.html).toBe('&lt;x&gt;')
  })
})

// ─── Includes ───────────────────────────────────────────────────────────────

describe('compile — @include', () => {
  test('@include without data forwards an empty object', async () => {
    let captured = ''
    const ctx = renderCtx({
      async include(name, data) {
        captured = `${name}|${JSON.stringify(data)}`
        return `<inc:${name}>`
      },
    })
    const c = compile(tokenize("@include('partials.header')"))
    const r = await c.render({}, ctx)
    expect(r.html).toBe('<inc:partials.header>')
    expect(captured).toBe('partials.header|{}')
  })

  test('@include with data forwards the expression', async () => {
    let captured: unknown = null
    const ctx = renderCtx({
      async include(_name, data) {
        captured = data
        return ''
      },
    })
    await compile(tokenize("@include('partials.alert', { kind: 'info', text: 'hi' })")).render(
      {},
      ctx,
    )
    expect(captured).toEqual({ kind: 'info', text: 'hi' })
  })
})

// ─── Components ─────────────────────────────────────────────────────────────

describe('compile — @component', () => {
  test('captures body as slot + forwards props to ctx.component', async () => {
    const received: { value: { name: string; props: unknown; slot: string } | null } = {
      value: null,
    }
    const ctx = renderCtx({
      async component(name, props, slot) {
        received.value = { name, props, slot }
        return `<comp:${name}:${slot}>`
      },
    })
    const r = await compile(
      tokenize("@component('alert', { kind: 'success' })<b>Saved</b>@endcomponent"),
    ).render({}, ctx)
    expect(r.html).toBe('<comp:alert:<b>Saved</b>>')
    expect(received.value).toEqual({
      name: 'alert',
      props: { kind: 'success' },
      slot: '<b>Saved</b>',
    })
  })
})

// ─── Errors ─────────────────────────────────────────────────────────────────

describe('compile — error paths', () => {
  test('unknown `@words` pass through as literal text (e.g. `@nope`, emails)', async () => {
    // The tokenizer recognises directives only from the frozen set;
    // anything else stays as text. Lets `hello@example.com` and stray
    // `@words` survive without compile errors.
    const r = await compileRender('@nope hello@example.com')
    expect(r.html).toBe('@nope hello@example.com')
  })

  test("@island('Name', { props }) compiles to a ctx.island call", async () => {
    const r = await compileRender("@island('LeadKanban', { initial: 42 })")
    expect(r.html).toBe('<island:LeadKanban:{"initial":42}>')
  })

  test('directive missing args throws', () => {
    expect(() => compile(tokenize('@if'))).toThrow(/requires an argument list/)
  })

  test('multiple @extends throws', () => {
    expect(() => compile(tokenize("@extends('a')\n@extends('b')"))).toThrow(/Multiple @extends/)
  })

  test('@yield with non-literal arg throws', () => {
    expect(() => compile(tokenize('@yield(name)'))).toThrow(/string literal/)
  })

  test('runtime expression error wraps to TemplateError-friendly stack', async () => {
    // Throwing inside `{{ expr }}` — compile succeeds, render throws.
    const c = compile(tokenize('{{ data.missing.nested }}'))
    await expect(c.render({ data: {} }, renderCtx())).rejects.toThrow()
  })
})
