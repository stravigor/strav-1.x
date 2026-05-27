import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Application,
  type Application as ApplicationType,
  ConfigProvider,
  isUlid,
  LoggerProvider,
  ServiceProvider,
  ulid,
} from '@strav/kernel'
import type { HttpContext } from '../src/context/types.ts'
import {
  corsMiddleware,
  HttpKernel,
  HttpProvider,
  MiddlewareRegistry,
  Router,
  securityHeadersMiddleware,
} from '../src/index.ts'
import type { MiddlewareFn } from '../src/middleware/types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let logDir: { path: string; cleanup: () => void; logFile: string }

beforeEach(() => {
  const path = mkdtempSync(join(tmpdir(), 'strav-built-ins-'))
  logDir = {
    path,
    logFile: join(path, 'app.log'),
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  }
})
afterEach(() => {
  logDir.cleanup()
})

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
  httpConfig: Record<string, unknown> = {},
  logLevel: 'trace' | 'info' | 'error' = 'info',
): Promise<Application> {
  const app = new Application()
  const providers: ServiceProvider[] = [
    new ConfigProvider({
      logger: {
        default: 'file',
        level: logLevel,
        channels: { file: { driver: 'single', path: logDir.logFile } },
      },
      http: httpConfig,
    }),
    new LoggerProvider(),
    new HttpProvider(),
  ]
  if (seed) providers.push(seedProvider(seed))
  app.useProviders(providers)
  await app.start({ signalHandlers: false })
  return app
}

function readLogLines(path: string): Array<Record<string, unknown>> {
  const text = readFileSync(path, 'utf8').trim()
  if (!text) return []
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

// ─────────────────────────────────────────────────────────────────────────────
// Kernel: request-id
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpKernel — request-id', () => {
  test('mints a ULID per request when no upstream header', async () => {
    let seen: string | undefined
    const app = await bootApp((router) => {
      router.get('/x', (ctx) => {
        seen = ctx.state.requestId
        return ctx.response.ok({ id: ctx.state.requestId })
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/x'))
      const headerId = res.headers.get('X-Request-Id')
      expect(headerId).toBeTruthy()
      expect(isUlid(headerId ?? '')).toBe(true)
      expect(seen).toBe(headerId ?? '')
      expect(await res.json()).toEqual({ id: headerId })
    } finally {
      await app.shutdown()
    }
  })

  test('two requests get different request ids', async () => {
    const app = await bootApp((router) => router.get('/x', () => null))
    try {
      const a = await app.resolve(HttpKernel).handle(new Request('http://localhost/x'))
      const b = await app.resolve(HttpKernel).handle(new Request('http://localhost/x'))
      expect(a.headers.get('X-Request-Id')).not.toBe(b.headers.get('X-Request-Id'))
    } finally {
      await app.shutdown()
    }
  })

  test('honors a trusted upstream X-Request-Id (ULID)', async () => {
    const app = await bootApp((router) =>
      router.get('/x', (ctx) => ctx.response.ok({ id: ctx.state.requestId })),
    )
    try {
      // Generate via the same `ulid()` the kernel uses — guarantees Crockford
      // alphabet validity without hand-rolling a fixture.
      const trusted = ulid()
      expect(isUlid(trusted)).toBe(true)
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/x', { headers: { 'x-request-id': trusted } }))
      expect(res.headers.get('X-Request-Id')).toBe(trusted)
      expect(await res.json()).toEqual({ id: trusted })
    } finally {
      await app.shutdown()
    }
  })

  test('rejects a non-ULID upstream X-Request-Id (mints a fresh one)', async () => {
    const app = await bootApp((router) => router.get('/x', () => null))
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/x', { headers: { 'x-request-id': 'not-a-ulid' } }))
      const id = res.headers.get('X-Request-Id') ?? ''
      expect(id).not.toBe('not-a-ulid')
      expect(isUlid(id)).toBe(true)
    } finally {
      await app.shutdown()
    }
  })

  test('ctx.log is pre-bound to a child with requestId', async () => {
    const app = await bootApp((router) => {
      router.get('/x', (ctx) => {
        ctx.log.info('handler.ran')
        return ctx.response.ok({ ok: true })
      })
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/x'))
      const requestId = res.headers.get('X-Request-Id') ?? ''
      // Need to flush the logger before reading the file.
      await app.shutdown()
      const lines = readLogLines(logDir.logFile)
      const handlerLine = lines.find((l) => l.msg === 'handler.ran')
      expect(handlerLine).toBeDefined()
      expect(handlerLine?.requestId).toBe(requestId)
    } catch (err) {
      await app.shutdown()
      throw err
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// security_headers
// ─────────────────────────────────────────────────────────────────────────────

describe('security_headers middleware', () => {
  test('defaults attach on every response', async () => {
    const app = await bootApp((router) => router.get('/x', () => ({ ok: true })), {
      middleware: ['security_headers'],
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/x'))
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'self'")
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
      expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000')
    } finally {
      await app.shutdown()
    }
  })

  test('config override replaces a default; null removes one', async () => {
    const app = await bootApp((router) => router.get('/x', () => ({ ok: true })), {
      middleware: ['security_headers'],
      securityHeaders: {
        headers: {
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data:",
          'Strict-Transport-Security': null,
        },
      },
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/x'))
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; img-src 'self' data:",
      )
      expect(res.headers.get('Strict-Transport-Security')).toBeNull()
      // Other defaults still present.
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    } finally {
      await app.shutdown()
    }
  })

  test('stand-alone factory works without HttpProvider wiring', async () => {
    const middleware = securityHeadersMiddleware({
      headers: { 'X-Custom-Header': 'value' },
    })
    expect(typeof middleware).toBe('function')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// cors
// ─────────────────────────────────────────────────────────────────────────────

describe('cors middleware', () => {
  test('no Origin header → pass-through (no CORS headers added)', async () => {
    const app = await bootApp((router) => router.get('/x', () => ({ ok: true })), {
      middleware: ['cors'],
    })
    try {
      const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/x'))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    } finally {
      await app.shutdown()
    }
  })

  test('default origin: * → echoes star, no credentials', async () => {
    const app = await bootApp((router) => router.get('/x', () => ({ ok: true })), {
      middleware: ['cors'],
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(
          new Request('http://localhost/x', { headers: { Origin: 'https://other.example.com' } }),
        )
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(res.headers.get('Vary')).toContain('Origin')
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    } finally {
      await app.shutdown()
    }
  })

  test('exact origin allowlist → echoes the matched origin', async () => {
    const app = await bootApp((router) => router.get('/x', () => ({ ok: true })), {
      middleware: ['cors'],
      cors: {
        origin: ['https://app.example.com', 'https://admin.example.com'],
        credentials: true,
      },
    })
    try {
      const allowed = await app
        .resolve(HttpKernel)
        .handle(
          new Request('http://localhost/x', { headers: { Origin: 'https://app.example.com' } }),
        )
      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com')
      expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true')

      const denied = await app
        .resolve(HttpKernel)
        .handle(
          new Request('http://localhost/x', { headers: { Origin: 'https://evil.example.com' } }),
        )
      expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()
    } finally {
      await app.shutdown()
    }
  })

  test('preflight: short-circuits before the route handler', async () => {
    let handlerRan = false
    const app = await bootApp(
      (router) =>
        router.post('/x', () => {
          handlerRan = true
          return null
        }),
      {
        middleware: ['cors'],
        cors: { origin: ['https://app.example.com'], maxAge: 3600 },
      },
    )
    try {
      const res = await app.resolve(HttpKernel).handle(
        new Request('http://localhost/x', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://app.example.com',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type, authorization',
          },
        }),
      )
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com')
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
      expect(res.headers.get('Access-Control-Allow-Headers')).toBe('content-type, authorization')
      expect(res.headers.get('Access-Control-Max-Age')).toBe('3600')
      expect(handlerRan).toBe(false)
    } finally {
      await app.shutdown()
    }
  })

  test('function origin matcher', async () => {
    const middleware = corsMiddleware({
      origin: (origin) => origin.endsWith('.example.com'),
    })
    // Drive it directly so we don't depend on the registry wiring.
    const ctx = {
      request: {
        headers: new Headers({ Origin: 'https://acme.example.com' }),
        isMethod: () => false,
        hasHeader: () => false,
      },
      response: {
        header: (n: string, v: string) => {
          headers[n] = v
        },
      },
    }
    const headers: Record<string, string> = {}
    await middleware(ctx as unknown as HttpContext, async () => new Response('x'))
    expect(headers['Access-Control-Allow-Origin']).toBe('https://acme.example.com')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// request_log
// ─────────────────────────────────────────────────────────────────────────────

describe('request_log middleware', () => {
  test('emits one http.request log line per request with method/path/status/duration', async () => {
    const app = await bootApp(
      (router) => router.get('/health', (ctx) => ctx.response.ok({ ok: true })),
      { middleware: ['request_log'] },
      'info',
    )
    const res = await app.resolve(HttpKernel).handle(new Request('http://localhost/health'))
    const requestId = res.headers.get('X-Request-Id') ?? ''
    // terminate runs in queueMicrotask after handle resolves; shutdown drains the logger.
    await app.shutdown()

    const lines = readLogLines(logDir.logFile)
    const reqLine = lines.find((l) => l.msg === 'http.request')
    expect(reqLine).toBeDefined()
    expect(reqLine?.method).toBe('GET')
    expect(reqLine?.path).toBe('/health')
    expect(reqLine?.status).toBe(200)
    expect(typeof reqLine?.duration_ms).toBe('number')
    expect(reqLine?.requestId).toBe(requestId)
  })

  test('logs the error status when the handler throws', async () => {
    const app = await bootApp(
      (router) =>
        router.get('/boom', () => {
          throw new Error('kaboom')
        }),
      { middleware: ['request_log'] },
      'info',
    )
    await app
      .resolve(HttpKernel)
      .handle(new Request('http://localhost/boom', { headers: { accept: 'application/json' } }))
    await app.shutdown()
    const lines = readLogLines(logDir.logFile)
    const reqLine = lines.find((l) => l.msg === 'http.request')
    expect(reqLine?.status).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HttpProvider — auto-registration + override
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpProvider — built-in auto-registration', () => {
  test('built-ins are usable from config.http.middleware without manual register()', async () => {
    const app = await bootApp((router) => router.get('/x', () => ({ ok: true })), {
      middleware: ['security_headers', 'cors', 'request_log'],
    })
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/x', { headers: { Origin: 'https://anywhere' } }))
      expect(res.headers.get('X-Frame-Options')).toBe('DENY')
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    } finally {
      await app.shutdown()
    }
  })

  test('app can replace a built-in via MiddlewareRegistry.replace()', async () => {
    const sentinel: MiddlewareFn = async (ctx, next) => {
      ctx.response.header('X-Cors-Override', 'custom')
      return next()
    }
    const app = await bootApp(
      (router, reg) => {
        reg.replace('cors', sentinel)
        router.get('/x', () => ({ ok: true }))
      },
      { middleware: ['cors'] },
    )
    try {
      const res = await app
        .resolve(HttpKernel)
        .handle(new Request('http://localhost/x', { headers: { Origin: 'https://x' } }))
      expect(res.headers.get('X-Cors-Override')).toBe('custom')
      // The default cors handler would have added Vary: Origin; the override doesn't.
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    } finally {
      await app.shutdown()
    }
  })
})
