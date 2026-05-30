import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Application,
  type Application as ApplicationType,
  ConfigProvider,
  inject,
  Logger,
  LoggerProvider,
  NotFoundError,
  ServiceProvider,
  ValidationError,
} from '@strav/kernel'
import type { HttpContext } from '../src/context/types.ts'
import { ExceptionHandler } from '../src/exception_handler.ts'
import { HttpKernel } from '../src/http_kernel.ts'
import { HttpProvider } from '../src/http_provider.ts'
import { MiddlewareRegistry } from '../src/middleware/registry.ts'
import type { MiddlewareFn } from '../src/middleware/types.ts'
import { Router } from '../src/router/router.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Setup helpers
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void }

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-http-'))
  logDir = { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
})
afterEach(() => {
  logDir.cleanup()
})

/**
 * Build a one-off provider that seeds routes + middleware in its `register()`
 * pass — runs after `HttpProvider.register()` (so the Router is bound) and
 * before `HttpProvider.boot()` (which compiles the trie + precompiles plans).
 */
function seedProvider(seed: (router: Router, reg: MiddlewareRegistry) => void): ServiceProvider {
  return new (class extends ServiceProvider {
    override readonly name = 'test-routes'
    override readonly dependencies = ['http']
    override register(app: ApplicationType): void {
      seed(app.resolve(Router), app.resolve(MiddlewareRegistry))
    }
  })()
}

async function bootApp(
  seed?: (router: Router, reg: MiddlewareRegistry) => void,
  extraConfig: Record<string, unknown> = {},
): Promise<Application> {
  const app = new Application()
  const providers: ServiceProvider[] = [
    new ConfigProvider({
      logger: {
        default: 'file',
        level: 'error',
        channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
      },
      ...extraConfig,
    }),
    new LoggerProvider(),
    new HttpProvider(),
  ]
  if (seed) providers.push(seedProvider(seed))
  app.useProviders(providers)
  await app.start({ signalHandlers: false })
  return app
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpKernel.handle — happy path', () => {
  test('closure handler returns JSON body for a plain object', async () => {
    const app = await bootApp((router) => {
      router.get('/health', () => ({ ok: true }))
    })
    try {
      const kernel = app.resolve(HttpKernel)
      const res = await kernel.handle(new Request('http://localhost/health'))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await app.shutdown()
    }
  })

  test('closure returning Response passes through', async () => {
    const app = await bootApp((router) => {
      router.get('/teapot', () => new Response('short and stout', { status: 418 }))
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/teapot'))
      expect(res.status).toBe(418)
      expect(await res.text()).toBe('short and stout')
    } finally {
      await app.shutdown()
    }
  })

  test('closure returning null → 204', async () => {
    const app = await bootApp((router) => {
      router.delete('/x', () => null)
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/x', { method: 'DELETE' }))
      expect(res.status).toBe(204)
    } finally {
      await app.shutdown()
    }
  })

  test('tuple [Class, method] handler is instantiated per request via container', async () => {
    let constructed = 0
    @inject()
    class UserController {
      constructor() {
        constructed++
      }
      show(ctx: HttpContext): Response {
        return ctx.response.ok({ id: ctx.request.params.id })
      }
    }
    const app = await bootApp((router) => {
      router.get('/users/:id', [UserController, 'show'])
    })
    try {
      const kernel = app.resolve(HttpKernel)
      const res1 = await kernel.handle(new Request('http://localhost/users/1'))
      const res2 = await kernel.handle(new Request('http://localhost/users/2'))
      expect(constructed).toBe(2) // one per request — separate scopes
      expect(await res1.json()).toEqual({ id: '1' })
      expect(await res2.json()).toEqual({ id: '2' })
    } finally {
      await app.shutdown()
    }
  })

  test('single-action class handler calls .handle(ctx)', async () => {
    @inject()
    class HealthCheck {
      handle(ctx: HttpContext): Response {
        return ctx.response.ok({ alive: true })
      }
    }
    const app = await bootApp((router) => {
      router.get('/health', HealthCheck)
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/health'))
      expect(await res.json()).toEqual({ alive: true })
    } finally {
      await app.shutdown()
    }
  })

  test('controller injected services resolve from the request scope', async () => {
    @inject()
    class Counter {
      n = 0
      tick(): number {
        return ++this.n
      }
    }
    @inject()
    class CounterController {
      constructor(private counter: Counter) {}
      tick(ctx: HttpContext): Response {
        return ctx.response.ok({ n: this.counter.tick() })
      }
    }
    const app = await bootApp((router) => {
      router.get('/tick', [CounterController, 'tick'])
    })
    app.scoped(Counter)
    try {
      const kernel = app.resolve(HttpKernel)
      // Each request gets its own Counter (scoped) — both responses see n=1.
      const a = await kernel.handle(new Request('http://localhost/tick'))
      const b = await kernel.handle(new Request('http://localhost/tick'))
      expect(await a.json()).toEqual({ n: 1 })
      expect(await b.json()).toEqual({ n: 1 })
    } finally {
      await app.shutdown()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Error path
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpKernel.handle — errors', () => {
  test('unknown route → 404 with JSON body', async () => {
    const app = await bootApp()
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(
          new Request('http://localhost/missing', { headers: { accept: 'application/json' } }),
        )
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('http.not-found')
    } finally {
      await app.shutdown()
    }
  })

  test('wrong method → 405 with Allow header', async () => {
    const app = await bootApp((router) => {
      router.get('/x', () => ({ ok: true }))
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/x', { method: 'POST' }))
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET')
    } finally {
      await app.shutdown()
    }
  })

  test('handler throws StravError → status + code in body', async () => {
    const app = await bootApp((router) => {
      router.get('/u/:id', () => {
        throw new NotFoundError('User not found.', {
          code: 'user.not-found',
          context: { id: 'abc' },
        })
      })
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/u/abc', { headers: { accept: 'application/json' } }))
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { code: string; context: { id: string } } }
      expect(body.error.code).toBe('user.not-found')
      expect(body.error.context).toEqual({ id: 'abc' })
    } finally {
      await app.shutdown()
    }
  })

  test('ValidationError surfaces errors map', async () => {
    const app = await bootApp((router) => {
      router.post('/sign-in', () => {
        throw new ValidationError('Validation failed.', {
          code: 'validation.failed',
          context: { errors: { email: [{ code: 'rule.email.invalid', message: 'invalid' }] } },
        })
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(
        new Request('http://localhost/sign-in', {
          method: 'POST',
          headers: { accept: 'application/json' },
        }),
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { errors: Record<string, unknown> } }
      expect(body.error.errors).toEqual({
        email: [{ code: 'rule.email.invalid', message: 'invalid' }],
      })
    } finally {
      await app.shutdown()
    }
  })

  test('plain thrown Error → 500', async () => {
    const app = await bootApp((router) => {
      router.get('/boom', () => {
        throw new Error('something went wrong')
      })
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/boom', { headers: { accept: 'application/json' } }))
      expect(res.status).toBe(500)
    } finally {
      await app.shutdown()
    }
  })

  test('app can replace ExceptionHandler with a subclass', async () => {
    class CustomHandler extends ExceptionHandler {
      override renderHttp(): Response {
        return new Response('custom', { status: 418 })
      }
    }
    const app = new Application()
    app.singleton(ExceptionHandler, (c) => new CustomHandler(c.resolve(Logger)))
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'file',
          level: 'error',
          channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
        },
      }),
      new LoggerProvider(),
      new HttpProvider(),
      seedProvider((router) => {
        router.get('/boom', () => {
          throw new Error('x')
        })
      }),
    ])
    await app.start({ signalHandlers: false })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/boom'))
      expect(res.status).toBe(418)
      expect(await res.text()).toBe('custom')
    } finally {
      await app.shutdown()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Middleware integration
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpKernel.handle — middleware', () => {
  test('global middleware runs around route middleware around handler', async () => {
    const log: string[] = []
    const app = await bootApp(
      (router, reg) => {
        const global: MiddlewareFn = async (_, next) => {
          log.push('global-in')
          const r = await next()
          log.push('global-out')
          return r
        }
        const route: MiddlewareFn = async (_, next) => {
          log.push('route-in')
          const r = await next()
          log.push('route-out')
          return r
        }
        reg.register('global', global)
        reg.register('route', route)
        router
          .get('/x', (ctx) => {
            log.push('handler')
            return ctx.response.ok({ ok: true })
          })
          .middleware('route')
      },
      { http: { middleware: ['global'] } },
    )
    try {
      await app.resolve(HttpKernel).handle(new Request('http://localhost/x'))
      expect(log).toEqual(['global-in', 'route-in', 'handler', 'route-out', 'global-out'])
    } finally {
      await app.shutdown()
    }
  })

  test('pending response.cookie() merges onto the returned response', async () => {
    const app = await bootApp((router) => {
      router.get('/login', (ctx) => {
        ctx.response.cookie('session', 'abc', { httpOnly: true, sameSite: 'lax' })
        return ctx.response.ok({ ok: true })
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/login'))
      const cookie = res.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('session=abc')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
    } finally {
      await app.shutdown()
    }
  })

  test('pending response.header() applies to the returned response', async () => {
    const app = await bootApp((router) => {
      router.get('/h', (ctx) => {
        ctx.response.header('X-Trace-Id', 'abc-123')
        return ctx.response.ok({ ok: true })
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/h'))
      expect(res.headers.get('X-Trace-Id')).toBe('abc-123')
    } finally {
      await app.shutdown()
    }
  })

  test('unknown middleware name → ConfigError at HttpProvider.boot()', async () => {
    const app = new Application()
    app.useProviders([
      new ConfigProvider({
        logger: {
          default: 'file',
          level: 'error',
          channels: { file: { driver: 'single', path: join(logDir.path, 'app.log') } },
        },
        http: { middleware: ['no-such-middleware'] },
      }),
      new LoggerProvider(),
      new HttpProvider(),
    ])
    await expect(app.start({ signalHandlers: false })).rejects.toThrow(/no middleware registered/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Context shape
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpKernel.handle — context shape', () => {
  test('server.host / hostname / protocol parse from request URL', async () => {
    const app = await bootApp((router) => {
      router.get('/who', (ctx) =>
        ctx.response.ok({
          host: ctx.server.host,
          hostname: ctx.server.hostname,
          protocol: ctx.server.protocol,
        }),
      )
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('https://api.example.com:8443/who'))
      const body = (await res.json()) as { host: string; hostname: string; protocol: string }
      expect(body.hostname).toBe('api.example.com')
      expect(body.protocol).toBe('https')
    } finally {
      await app.shutdown()
    }
  })

  test('appDomain config split: subdomain extracted', async () => {
    const app = await bootApp(
      (router) => {
        router.get('/who', (ctx) =>
          ctx.response.ok({ sub: ctx.server.subdomain, domain: ctx.server.domain }),
        )
      },
      { http: { appDomain: 'example.com' } },
    )
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('https://acme.api.example.com/who'))
      const body = (await res.json()) as { sub: string; domain: string }
      expect(body.sub).toBe('acme.api')
      expect(body.domain).toBe('example.com')
    } finally {
      await app.shutdown()
    }
  })

  test('request.query parses multi-value params', async () => {
    const app = await bootApp((router) => {
      router.get('/search', (ctx) => ctx.response.ok({ q: ctx.request.query }))
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/search?tag=a&tag=b&page=2'))
      const body = (await res.json()) as { q: Record<string, string | string[]> }
      expect(body.q.tag).toEqual(['a', 'b'])
      expect(body.q.page).toBe('2')
    } finally {
      await app.shutdown()
    }
  })

  test('request.json() parses JSON body once and caches', async () => {
    const app = await bootApp((router) => {
      router.post('/echo', async (ctx) => {
        const a = await ctx.request.json<{ x: number }>()
        const b = await ctx.request.json<{ x: number }>()
        return ctx.response.ok({ a, b })
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(
        new Request('http://localhost/echo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x: 7 }),
        }),
      )
      const body = (await res.json()) as { a: { x: number }; b: { x: number } }
      expect(body.a).toEqual({ x: 7 })
      expect(body.b).toEqual({ x: 7 })
    } finally {
      await app.shutdown()
    }
  })

  test('ctx.log is the application Logger (request-scoped child wiring TBD)', async () => {
    const app = await bootApp((router) => {
      router.get('/log', (ctx) => {
        ctx.log.info('handler.invoked')
        return ctx.response.ok({ ok: true })
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/log'))
      expect(res.status).toBe(200)
    } finally {
      await app.shutdown()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// publicDir static-asset fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpKernel.handle — publicDir static fallback', () => {
  let pubDir: string
  beforeEach(async () => {
    pubDir = mkdtempSync(join(tmpdir(), 'strav-http-public-'))
    await Bun.write(join(pubDir, 'hello.txt'), 'hi from disk')
    await Bun.write(join(pubDir, 'assets', 'app.css'), 'body{color:red}')
  })
  afterEach(() => {
    rmSync(pubDir, { recursive: true, force: true })
  })

  test('GET an unrouted path that exists in publicDir returns the file (200)', async () => {
    const app = await bootApp(undefined, { http: { publicDir: pubDir } })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/hello.txt'))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('hi from disk')
    } finally {
      await app.shutdown()
    }
  })

  test('GET a nested file under publicDir resolves', async () => {
    const app = await bootApp(undefined, { http: { publicDir: pubDir } })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/assets/app.css'))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('body{color:red}')
    } finally {
      await app.shutdown()
    }
  })

  test('routed paths still win over disk', async () => {
    const app = await bootApp(
      (router) => {
        router.get('/hello.txt', () => new Response('from router'))
      },
      { http: { publicDir: pubDir } },
    )
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/hello.txt'))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('from router')
    } finally {
      await app.shutdown()
    }
  })

  test('missing file falls through to 404', async () => {
    const app = await bootApp(undefined, { http: { publicDir: pubDir } })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/nope.txt'))
      expect(res.status).toBe(404)
    } finally {
      await app.shutdown()
    }
  })

  test('path traversal is rejected — `..` cannot escape publicDir', async () => {
    const app = await bootApp(undefined, { http: { publicDir: pubDir } })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/../../etc/passwd'))
      expect(res.status).toBe(404)
    } finally {
      await app.shutdown()
    }
  })

  test('POST to a file path does NOT serve it (only GET / HEAD fall through)', async () => {
    const app = await bootApp(undefined, { http: { publicDir: pubDir } })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/hello.txt', { method: 'POST' }))
      expect(res.status).toBe(404)
    } finally {
      await app.shutdown()
    }
  })

  test('HEAD returns empty body + 200 for existing files', async () => {
    const app = await bootApp(undefined, { http: { publicDir: pubDir } })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/hello.txt', { method: 'HEAD' }))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
    } finally {
      await app.shutdown()
    }
  })

  test('no publicDir set → 404 for every unrouted GET', async () => {
    const app = await bootApp(undefined, { http: {} })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/hello.txt'))
      expect(res.status).toBe(404)
    } finally {
      await app.shutdown()
    }
  })
})
