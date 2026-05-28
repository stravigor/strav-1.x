import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Router } from '../../http/src/router/router.ts'
import { fileToPage, registerPages } from '../src/pages.ts'
import { ViewEngine } from '../src/view_engine.ts'

// ─────────────────────────────────────────────────────────────────────────────
// fileToPage — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('fileToPage', () => {
  test('index.strav → GET /', () => {
    expect(fileToPage('index.strav')).toEqual({
      templateName: 'pages.index',
      urlPattern: '/',
    })
  })

  test('about.strav → GET /about', () => {
    const p = fileToPage('about.strav')
    expect(p?.urlPattern).toBe('/about')
    expect(p?.templateName).toBe('pages.about')
  })

  test('blog/index.strav → GET /blog (index collapses)', () => {
    const p = fileToPage('blog/index.strav')
    expect(p?.urlPattern).toBe('/blog')
    expect(p?.templateName).toBe('pages.blog.index')
  })

  test('blog/[slug].strav → GET /blog/:slug', () => {
    const p = fileToPage('blog/[slug].strav')
    expect(p?.urlPattern).toBe('/blog/:slug')
    expect(p?.templateName).toBe('pages.blog.[slug]')
  })

  test('docs/[...path].strav → GET /docs/*', () => {
    const p = fileToPage('docs/[...path].strav')
    expect(p?.urlPattern).toBe('/docs/*')
  })

  test('returns null for underscore file', () => {
    expect(fileToPage('_partials/cta.strav')).toBeNull()
    expect(fileToPage('blog/_draft.strav')).toBeNull()
  })

  test('returns null for underscore directory anywhere in path', () => {
    expect(fileToPage('docs/_internal/setup.strav')).toBeNull()
  })

  test('pricing.strav → GET /pricing', () => {
    const p = fileToPage('pricing.strav')
    expect(p?.urlPattern).toBe('/pricing')
  })

  test('nested path → multi-segment URL', () => {
    const p = fileToPage('docs/getting-started/install.strav')
    expect(p?.urlPattern).toBe('/docs/getting-started/install')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// registerPages — real filesystem + Router
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `strav-pages-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(join(tmpDir, 'pages'), { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writePage(name: string, content = '<p>page</p>') {
  const full = join(tmpDir, 'pages', name)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content, 'utf8')
}

function makeEngine() {
  return new ViewEngine({
    config: { directory: tmpDir, cache: false },
  })
}

describe('registerPages', () => {
  test('empty pages dir → no routes registered', async () => {
    const engine = makeEngine()
    const router = new Router()
    const pages = await registerPages(engine, router, { pagesDir: join(tmpDir, 'pages') })
    expect(pages).toHaveLength(0)
  })

  test('non-existent pages dir → returns empty gracefully', async () => {
    const engine = makeEngine()
    const router = new Router()
    const pages = await registerPages(engine, router, {
      pagesDir: join(tmpDir, 'does-not-exist'),
    })
    expect(pages).toHaveLength(0)
  })

  test('registers one route per .strav file', async () => {
    await writePage('index.strav')
    await writePage('about.strav')
    await writePage('blog/[slug].strav', '{{ params.slug }}')

    const engine = makeEngine()
    const router = new Router()
    const pages = await registerPages(engine, router, { pagesDir: join(tmpDir, 'pages') })

    expect(pages.map((p) => p.urlPattern).sort()).toEqual(['/about', '/', '/blog/:slug'].sort())
  })

  test('skips files with underscore segments', async () => {
    await writePage('about.strav')
    await writePage('_partials/cta.strav')

    const engine = makeEngine()
    const router = new Router()
    const pages = await registerPages(engine, router, { pagesDir: join(tmpDir, 'pages') })

    expect(pages).toHaveLength(1)
    expect(pages[0]?.urlPattern).toBe('/about')
  })

  test('registered route renders the template', async () => {
    await writePage('hello.strav', '<h1>Hello</h1>')

    const engine = makeEngine()
    const router = new Router()
    await registerPages(engine, router, { pagesDir: join(tmpDir, 'pages') })
    router.compile()

    const compiled = router.list()
    const helloRoute = compiled.find((r) => r.pattern === '/hello')

    // Simulate a request to verify the handler renders correctly.
    // We call the handler via a fake ctx — the handler only uses
    // engine.render + new Response, which doesn't need a real server.
    type FakeCtx = { request: { params: Record<string, string>; query: Record<string, string> } }
    const fakeCtx = { request: { params: {}, query: {} } } as FakeCtx
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const response = await (helloRoute!.handler as (ctx: FakeCtx) => Promise<Response>)(fakeCtx)
    const body = await response.text()
    expect(body).toContain('<h1>Hello</h1>')
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  test('applies middleware to every registered route', async () => {
    await writePage('home.strav')

    const engine = makeEngine()
    const router = new Router()
    const pages = await registerPages(engine, router, {
      pagesDir: join(tmpDir, 'pages'),
      middleware: ['auth', 'cache:public'],
    })
    router.compile()

    expect(pages).toHaveLength(1)
    const route = router.list()[0]!
    expect(route.middleware).toContain('auth')
    expect(route.middleware).toContain('cache:public')
  })
})
