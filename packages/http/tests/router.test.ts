import { describe, expect, test } from 'bun:test'
import { ConfigError } from '@strav/kernel'
import { Router, resolveRoute } from '../src/router/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Basic registration + matching
// ─────────────────────────────────────────────────────────────────────────────

describe('Router — match', () => {
  test('static path: GET /health', () => {
    const router = new Router()
    router.get('/health', () => new Response('ok'))
    const m = router.match('GET', '/health')
    expect(m.kind).toBe('found')
  })

  test('param path: /users/:id captures the segment', () => {
    const router = new Router()
    router.get('/users/:id', () => new Response('user'))
    const m = router.match('GET', '/users/42')
    expect(m.kind).toBe('found')
    if (m.kind === 'found') {
      expect(m.params).toEqual({ id: '42' })
      expect(m.route.method).toBe('GET')
    }
  })

  test('multiple params: /tenants/:tenant/users/:id', () => {
    const router = new Router()
    router.get('/tenants/:tenant/users/:id', () => new Response('x'))
    const m = router.match('GET', '/tenants/acme/users/42')
    expect(m.kind).toBe('found')
    if (m.kind === 'found') {
      expect(m.params).toEqual({ tenant: 'acme', id: '42' })
    }
  })

  test('optional param: /users/:id? matches both forms', () => {
    const router = new Router()
    router.get('/users/:id?', () => new Response('x'))
    const matchWithId = router.match('GET', '/users/42')
    const matchWithoutId = router.match('GET', '/users')
    expect(matchWithId.kind).toBe('found')
    expect(matchWithoutId.kind).toBe('found')
    if (matchWithId.kind === 'found') expect(matchWithId.params).toEqual({ id: '42' })
    if (matchWithoutId.kind === 'found') expect(matchWithoutId.params).toEqual({})
  })

  test('wildcard: /files/*path captures the remainder', () => {
    const router = new Router()
    router.get('/files/*path', () => new Response('x'))
    const m = router.match('GET', '/files/a/b/c.txt')
    expect(m.kind).toBe('found')
    if (m.kind === 'found') expect(m.params).toEqual({ path: 'a/b/c.txt' })
  })

  test('static beats param at the same level', () => {
    const router = new Router()
    router.get('/users/me', () => new Response('me'))
    router.get('/users/:id', () => new Response('user'))
    const m = router.match('GET', '/users/me')
    expect(m.kind).toBe('found')
    if (m.kind === 'found') expect(m.params).toEqual({})
  })

  test('URL-encoded params are decoded', () => {
    const router = new Router()
    router.get('/q/:term', () => new Response('x'))
    const m = router.match('GET', '/q/hello%20world')
    expect(m.kind).toBe('found')
    if (m.kind === 'found') expect(m.params.term).toBe('hello world')
  })

  test('unknown path: 404', () => {
    const router = new Router()
    router.get('/health', () => new Response('ok'))
    expect(router.match('GET', '/missing').kind).toBe('not-found')
  })

  test('known path, wrong method: 405 with allowed list', () => {
    const router = new Router()
    router.get('/users/:id', () => new Response('x'))
    router.delete('/users/:id', () => new Response('x'))
    const m = router.match('POST', '/users/42')
    expect(m.kind).toBe('method-not-allowed')
    if (m.kind === 'method-not-allowed') {
      expect(m.allowed.sort()).toEqual(['DELETE', 'GET'])
    }
  })

  test('duplicate route declaration throws', () => {
    const router = new Router()
    router.get('/x', () => new Response('a'))
    router.get('/x', () => new Response('b'))
    expect(() => router.compile()).toThrow(/duplicate/)
  })

  test('cannot add after compile()', () => {
    const router = new Router()
    router.get('/x', () => new Response('a'))
    router.compile()
    expect(() => router.get('/y', () => new Response('b'))).toThrow(ConfigError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────────────────────

describe('Router — groups', () => {
  test('prefix concatenation', () => {
    const router = new Router()
    router.group({ prefix: '/api' }, (api) => {
      api.get('/users', () => new Response('x'))
    })
    expect(router.match('GET', '/api/users').kind).toBe('found')
  })

  test('nested groups concatenate prefixes + names + middleware', () => {
    const router = new Router()
    router.group({ prefix: '/api', name: 'api.', middleware: ['auth'] }, (api) => {
      api.group({ prefix: '/v1', name: 'v1.', middleware: 'throttle' }, (v1) => {
        v1.get('/users', () => new Response('x'))
          .name('users.index')
          .middleware('csrf')
      })
    })
    const compiled = router.list()
    expect(compiled).toHaveLength(1)
    const route = compiled[0]
    expect(route).toBeDefined()
    expect(route?.pattern).toBe('/api/v1/users')
    expect(route?.name).toBe('api.v1.users.index')
    expect(route?.middleware).toEqual(['auth', 'throttle', 'csrf'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Named routes + resolver
// ─────────────────────────────────────────────────────────────────────────────

describe('Router — named + resolver', () => {
  test('route("name", params) substitutes path params', () => {
    const router = new Router()
    router.get('/users/:id', () => new Response('x')).name('users.show')
    expect(resolveRoute(router, 'users.show', { id: 42 })).toBe('/users/42')
  })

  test('extra params become query string', () => {
    const router = new Router()
    router.get('/users/:id', () => new Response('x')).name('users.show')
    expect(resolveRoute(router, 'users.show', { id: 1, tab: 'profile' })).toBe(
      '/users/1?tab=profile',
    )
  })

  test('missing required param throws ConfigError', () => {
    const router = new Router()
    router.get('/users/:id', () => new Response('x')).name('users.show')
    expect(() => resolveRoute(router, 'users.show', {})).toThrow(ConfigError)
  })

  test('optional param is droppable', () => {
    const router = new Router()
    router.get('/users/:id?', () => new Response('x')).name('users.index')
    expect(resolveRoute(router, 'users.index', {})).toBe('/users')
    expect(resolveRoute(router, 'users.index', { id: 42 })).toBe('/users/42')
  })

  test('abs: true requires host', () => {
    const router = new Router()
    router.get('/h', () => new Response('x')).name('h')
    expect(() => resolveRoute(router, 'h', {}, { abs: true })).toThrow(ConfigError)
    expect(resolveRoute(router, 'h', {}, { abs: true, host: 'example.com' })).toBe(
      'https://example.com/h',
    )
  })

  test('unknown name throws ConfigError', () => {
    const router = new Router()
    expect(() => resolveRoute(router, 'nope', {})).toThrow(ConfigError)
  })

  test('duplicate route name throws at compile', () => {
    const router = new Router()
    router.get('/a', () => new Response('x')).name('dup')
    router.get('/b', () => new Response('x')).name('dup')
    expect(() => router.compile()).toThrow(ConfigError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Wildcard + verb shortcuts
// ─────────────────────────────────────────────────────────────────────────────

describe('Router — verbs', () => {
  test('every verb method registers correctly', () => {
    const router = new Router()
    router.get('/x', () => new Response(''))
    router.post('/x', () => new Response(''))
    router.put('/x', () => new Response(''))
    router.patch('/x', () => new Response(''))
    router.delete('/x', () => new Response(''))
    router.options('/x', () => new Response(''))
    router.head('/x', () => new Response(''))
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      expect(router.match(method, '/x').kind).toBe('found')
    }
  })

  test('any() registers every verb', () => {
    const router = new Router()
    router.any('/x', () => new Response(''))
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(router.match(method, '/x').kind).toBe('found')
    }
  })
})
