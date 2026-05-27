import { describe, expect, test } from 'bun:test'
import { Container, inject } from '@strav/kernel'
import type { HttpContext } from '../src/context/types.ts'
import { composeMiddleware } from '../src/middleware/compose.ts'
import { MiddlewareRegistry } from '../src/middleware/registry.ts'
import type { MiddlewareClass, MiddlewareFn } from '../src/middleware/types.ts'

// A minimal context stand-in — the middleware path only touches `ctx`'s identity.
function makeCtx(): HttpContext {
  // biome-ignore lint/suspicious/noExplicitAny: tests don't need a full HttpContext
  return {} as any
}

describe('composeMiddleware — order + short-circuit', () => {
  test('runs middleware in declaration order, final handler last', async () => {
    const log: string[] = []
    const a: MiddlewareFn = async (_, next) => {
      log.push('a-before')
      const r = await next()
      log.push('a-after')
      return r
    }
    const b: MiddlewareFn = async (_, next) => {
      log.push('b-before')
      const r = await next()
      log.push('b-after')
      return r
    }
    const chain = composeMiddleware(
      [a, b],
      () => {
        log.push('handler')
        return new Response('ok')
      },
      new Container(),
    )
    const res = await chain.invoke(makeCtx())
    expect(res.status).toBe(200)
    expect(log).toEqual(['a-before', 'b-before', 'handler', 'b-after', 'a-after'])
  })

  test('short-circuit: middleware that returns without next() skips downstream', async () => {
    const log: string[] = []
    const guard: MiddlewareFn = () => {
      log.push('guard')
      return new Response('blocked', { status: 401 })
    }
    const downstream: MiddlewareFn = async (_, next) => {
      log.push('downstream')
      return next()
    }
    const chain = composeMiddleware(
      [guard, downstream],
      () => {
        log.push('handler')
        return new Response('ok')
      },
      new Container(),
    )
    const res = await chain.invoke(makeCtx())
    expect(res.status).toBe(401)
    expect(log).toEqual(['guard'])
  })

  test('rejection from `next()` propagates out', async () => {
    const a: MiddlewareFn = async (_, next) => next()
    const chain = composeMiddleware(
      [a],
      () => {
        throw new Error('boom')
      },
      new Container(),
    )
    expect(chain.invoke(makeCtx())).rejects.toThrow('boom')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Class middleware + terminating
// ─────────────────────────────────────────────────────────────────────────────

describe('composeMiddleware — class middleware', () => {
  test('class is instantiated lazily per chain invocation', async () => {
    const calls: string[] = []
    @inject()
    class M implements MiddlewareClass {
      constructor() {
        calls.push('ctor')
      }
      handle: MiddlewareFn = async (_, next) => {
        calls.push('handle')
        return next()
      }
    }
    const container = new Container()
    const chain = composeMiddleware([M], () => new Response('x'), container)
    await chain.invoke(makeCtx())
    expect(calls).toEqual(['ctor', 'handle'])
  })

  test('terminate() instances are collected for post-response calls', async () => {
    @inject()
    class T implements MiddlewareClass {
      handle: MiddlewareFn = async (_, next) => next()
      terminate(_ctx: HttpContext, _response: Response): void {
        /* collected, not called by chain */
      }
    }
    const container = new Container()
    const chain = composeMiddleware([T], () => new Response('x'), container)
    await chain.invoke(makeCtx())
    const instances = chain.terminatingInstances()
    expect(instances).toHaveLength(1)
    expect(typeof instances[0]?.terminate).toBe('function')
  })

  test('class without terminate() is not collected', async () => {
    @inject()
    class M implements MiddlewareClass {
      handle: MiddlewareFn = async (_, next) => next()
    }
    const chain = composeMiddleware([M], () => new Response('x'), new Container())
    await chain.invoke(makeCtx())
    expect(chain.terminatingInstances()).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MiddlewareRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe('MiddlewareRegistry', () => {
  test('register + resolve a function middleware', () => {
    const reg = new MiddlewareRegistry()
    const fn: MiddlewareFn = (_, next) => next()
    reg.register('logger', fn)
    expect(reg.resolve('logger')).toBe(fn)
  })

  test('factory middleware: args parsed from `name:args`', () => {
    const reg = new MiddlewareRegistry()
    reg.register(
      'throttle',
      (limit?: string, window?: string) => {
        // Return a "configured" middleware (just a tagged function for the test).
        const fn: MiddlewareFn = (_, next) => next()
        Object.assign(fn, { limit, window })
        return fn
      },
      { factory: true },
    )
    const out = reg.resolve('throttle:60,1m') as MiddlewareFn & { limit: string; window: string }
    expect(out.limit).toBe('60')
    expect(out.window).toBe('1m')
  })

  test('unknown name throws ConfigError', () => {
    const reg = new MiddlewareRegistry()
    expect(() => reg.resolve('nope')).toThrow(/no middleware registered/)
  })

  test('non-factory with args throws ConfigError', () => {
    const reg = new MiddlewareRegistry()
    reg.register('auth', ((_, next) => next()) as MiddlewareFn)
    expect(() => reg.resolve('auth:web')).toThrow(/not a factory/)
  })

  test('duplicate registration throws', () => {
    const reg = new MiddlewareRegistry()
    reg.register('x', ((_, next) => next()) as MiddlewareFn)
    expect(() => reg.register('x', ((_, next) => next()) as MiddlewareFn)).toThrow(
      /already registered/,
    )
  })

  test('has() ignores `:args` suffix', () => {
    const reg = new MiddlewareRegistry()
    reg.register('throttle', () => ((_: HttpContext, next) => next()) as MiddlewareFn, {
      factory: true,
    })
    expect(reg.has('throttle:60,1m')).toBe(true)
    expect(reg.has('missing:x')).toBe(false)
  })
})
