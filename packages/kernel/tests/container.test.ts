import { describe, expect, test } from 'bun:test'

import { Container, inject } from '../src/core/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// register / singleton / scoped
// ─────────────────────────────────────────────────────────────────────────────

describe('register', () => {
  test('factory: produces a new instance each resolve', () => {
    const c = new Container()
    let calls = 0
    class Foo {
      readonly id = ++calls
    }
    c.register(Foo, () => new Foo())

    const a = c.resolve(Foo)
    const b = c.resolve(Foo)
    expect(a).not.toBe(b)
    expect(a.id).not.toBe(b.id)
  })

  test('string key: factory with string-keyed binding', () => {
    const c = new Container()
    c.register('greeting', () => ({ msg: 'hello' }))
    const g = c.resolve<{ msg: string }>('greeting')
    expect(g.msg).toBe('hello')
  })

  test('class with @inject(): used as both key and factory', () => {
    @inject()
    class Service {
      readonly tag = 'svc'
    }
    const c = new Container()
    c.register(Service)
    const s = c.resolve(Service)
    expect(s.tag).toBe('svc')
  })

  test('rebinding clears any cached instance', () => {
    const c = new Container()
    class Foo {
      readonly mark: string
      constructor(mark: string) {
        this.mark = mark
      }
    }
    c.singleton(Foo, () => new Foo('first'))
    const first = c.resolve(Foo)
    expect(first.mark).toBe('first')

    c.singleton(Foo, () => new Foo('second'))
    const second = c.resolve(Foo)
    expect(second.mark).toBe('second')
    expect(first).not.toBe(second)
  })
})

describe('singleton', () => {
  test('returns the same instance on every resolve', () => {
    @inject()
    class Logger {
      readonly id = Math.random()
    }
    const c = new Container()
    c.singleton(Logger)

    expect(c.resolve(Logger)).toBe(c.resolve(Logger))
  })

  test('string-keyed singleton', () => {
    const c = new Container()
    c.singleton('cache', () => ({ get: () => 1 }))
    expect(c.resolve<object>('cache')).toBe(c.resolve('cache'))
  })

  test('singleton bound at parent is shared by all scopes', () => {
    @inject()
    class Db {}
    const parent = new Container()
    parent.singleton(Db)

    const a = parent.createScope()
    const b = parent.createScope()

    const fromA = a.resolve(Db)
    const fromB = b.resolve(Db)
    const fromParent = parent.resolve(Db)
    expect(fromA).toBe(fromB)
    expect(fromA).toBe(fromParent)
  })
})

describe('scoped', () => {
  test('one instance per scope', () => {
    @inject()
    class RequestCtx {}
    const parent = new Container()
    parent.scoped(RequestCtx)

    const a = parent.createScope()
    const b = parent.createScope()

    const fromA = a.resolve(RequestCtx)
    const fromB = b.resolve(RequestCtx)
    expect(fromA).not.toBe(fromB)
    expect(fromA).toBe(a.resolve(RequestCtx)) // stable within the same scope
  })

  test('dispose() clears cached scoped instances', () => {
    @inject()
    class S {}
    const c = new Container().scoped(S)
    const scope = c.createScope()

    const first = scope.resolve(S)
    scope.dispose()
    const second = scope.resolve(S)
    expect(first).not.toBe(second)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// make() — auto-construction via @inject()
// ─────────────────────────────────────────────────────────────────────────────

describe('make', () => {
  test('class without constructor params: works without @inject()', () => {
    class Empty {}
    const c = new Container()
    expect(c.make(Empty)).toBeInstanceOf(Empty)
  })

  test('class with @inject() and class params: deps auto-resolved', () => {
    @inject()
    class A {
      readonly tag = 'a'
    }
    @inject()
    class B {
      constructor(public a: A) {}
    }
    @inject()
    class C {
      constructor(
        public a: A,
        public b: B,
      ) {}
    }

    const c = new Container()
    const made = c.make(C)
    expect(made).toBeInstanceOf(C)
    expect(made.a).toBeInstanceOf(A)
    expect(made.b).toBeInstanceOf(B)
    expect(made.b.a).toBeInstanceOf(A)
  })

  test('bound deps are honored (singleton instance shared)', () => {
    @inject()
    class Shared {}
    @inject()
    class User {
      constructor(public s: Shared) {}
    }
    const c = new Container().singleton(Shared)
    const u1 = c.make(User)
    const u2 = c.make(User)
    expect(u1.s).toBe(u2.s)
  })

  test('class with params but no @inject(): clear error', () => {
    class Needy {
      constructor(public dep: string) {}
    }
    const c = new Container()
    expect(() => c.make(Needy)).toThrow(/not marked with @inject/i)
  })

  test('make uses singleton binding if present', () => {
    @inject()
    class Repo {}
    const c = new Container().singleton(Repo)
    expect(c.make(Repo)).toBe(c.make(Repo))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolve() — strict lookup
// ─────────────────────────────────────────────────────────────────────────────

describe('resolve', () => {
  test('unbound class: throws with clear error', () => {
    class Unbound {}
    const c = new Container()
    expect(() => c.resolve(Unbound)).toThrow(/not registered/i)
  })

  test('unbound string key: throws with clear error', () => {
    const c = new Container()
    expect(() => c.resolve('missing')).toThrow(/not registered/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// has()
// ─────────────────────────────────────────────────────────────────────────────

describe('has', () => {
  test('returns true for bound class/string; false otherwise', () => {
    @inject()
    class A {}
    const c = new Container().singleton(A).singleton('cache', () => ({}))
    expect(c.has(A)).toBe(true)
    expect(c.has('cache')).toBe(true)
    class B {}
    expect(c.has(B)).toBe(false)
    expect(c.has('missing')).toBe(false)
  })

  test('walks the parent chain', () => {
    @inject()
    class A {}
    const parent = new Container().singleton(A)
    const scope = parent.createScope()
    expect(scope.has(A)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// bind(Interface, Concrete)
// ─────────────────────────────────────────────────────────────────────────────

describe('bind', () => {
  test('interface → concrete: resolving the interface gives the concrete', () => {
    @inject()
    class RedisCache {
      readonly kind = 'redis'
    }
    const c = new Container()
    c.bind('cache', RedisCache)
    const got = c.resolve<RedisCache>('cache')
    expect(got).toBeInstanceOf(RedisCache)
    expect(got.kind).toBe('redis')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tag / tagged
// ─────────────────────────────────────────────────────────────────────────────

describe('tag / tagged', () => {
  test('tagged returns every tagged class', () => {
    @inject()
    class A {
      readonly kind = 'a'
    }
    @inject()
    class B {
      readonly kind = 'b'
    }
    const c = new Container()
    c.tag([A, B], 'reporters')
    const all = c.tagged<A | B>('reporters')
    expect(all).toHaveLength(2)
    const kinds = all.map((r) => r.kind).sort()
    expect(kinds).toEqual(['a', 'b'])
  })

  test('tagged with no matching tag returns []', () => {
    const c = new Container()
    expect(c.tagged('nope')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// when().needs().give()
// ─────────────────────────────────────────────────────────────────────────────

describe('contextual binding', () => {
  test('overrides the implementation for one consumer', () => {
    @inject()
    class Cache {
      readonly kind: string = 'default'
    }
    @inject()
    class RedisCache extends Cache {
      override readonly kind: string = 'redis'
    }

    @inject()
    class BillingController {
      constructor(public cache: Cache) {}
    }
    @inject()
    class LeadController {
      constructor(public cache: Cache) {}
    }

    const c = new Container()
    c.when(BillingController).needs(Cache).give(RedisCache)

    expect(c.make(BillingController).cache.kind).toBe('redis')
    expect(c.make(LeadController).cache.kind).toBe('default')
  })

  test('overrides can be factories', () => {
    @inject()
    class Cache {
      readonly kind: string = 'default'
    }
    @inject()
    class Ctrl {
      constructor(public cache: Cache) {}
    }
    const c = new Container()
    c.when(Ctrl)
      .needs(Cache)
      .give(() => ({ kind: 'custom' }) as Cache)

    expect(c.make(Ctrl).cache.kind).toBe('custom')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// scopes
// ─────────────────────────────────────────────────────────────────────────────

describe('createScope', () => {
  test('scope inherits parent bindings', () => {
    @inject()
    class Db {}
    const parent = new Container().singleton(Db)
    const scope = parent.createScope()
    expect(scope.resolve(Db)).toBeInstanceOf(Db)
  })

  test('scope-local bindings are not visible to siblings', () => {
    @inject()
    class Req {}
    const parent = new Container()
    const a = parent.createScope().singleton(Req)
    const b = parent.createScope()

    expect(a.resolve(Req)).toBeInstanceOf(Req)
    expect(() => b.resolve(Req)).toThrow(/not registered/)
  })

  test('scope can override a parent singleton with its own binding', () => {
    @inject()
    class Foo {
      readonly tag: string
      constructor(tag = 'parent') {
        this.tag = tag
      }
    }
    const parent = new Container().singleton(Foo, () => new Foo('parent'))
    const scope = parent.createScope().singleton(Foo, () => new Foo('scope'))

    expect(parent.resolve(Foo).tag).toBe('parent')
    expect(scope.resolve(Foo).tag).toBe('scope')
  })
})
