import { afterEach, describe, expect, mock, test } from 'bun:test'

import { Application, inject, ServiceProvider } from '../src/core/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures — a tiny `ProbeProvider` that records lifecycle calls.
// ─────────────────────────────────────────────────────────────────────────────

class ProbeProvider extends ServiceProvider {
  override readonly name: string
  override readonly dependencies: readonly string[]
  readonly calls: string[]
  bootError?: Error

  constructor(
    name: string,
    dependencies: readonly string[] = [],
    opts: { bootError?: Error } = {},
  ) {
    super()
    this.name = name
    this.dependencies = dependencies
    this.calls = []
    this.bootError = opts.bootError
  }

  override register(_app: Application): void {
    this.calls.push('register')
  }

  override async boot(_app: Application): Promise<void> {
    this.calls.push('boot')
    if (this.bootError) throw this.bootError
  }

  override async shutdown(_app: Application): Promise<void> {
    this.calls.push('shutdown')
  }
}

// Track all process.on/off side-effects across tests; restore in afterEach.
const installed: Array<{ signal: NodeJS.Signals; handler: NodeJS.SignalsListener }> = []
const origOn = process.on.bind(process)
const origOff = process.off.bind(process)

afterEach(() => {
  for (const { signal, handler } of installed) origOff(signal, handler)
  installed.length = 0
})

// ─────────────────────────────────────────────────────────────────────────────
// Provider registration
// ─────────────────────────────────────────────────────────────────────────────

describe('Application.use / useProviders', () => {
  test('use adds a provider', async () => {
    const app = new Application()
    const p = new ProbeProvider('a')
    app.use(p)
    await app.start({ signalHandlers: false })
    expect(p.calls).toEqual(['register', 'boot'])
  })

  test('useProviders adds many at once', async () => {
    const app = new Application()
    const a = new ProbeProvider('a')
    const b = new ProbeProvider('b')
    app.useProviders([a, b])
    await app.start({ signalHandlers: false })
    expect(a.calls).toEqual(['register', 'boot'])
    expect(b.calls).toEqual(['register', 'boot'])
  })

  test('use after start throws', async () => {
    const app = new Application()
    await app.start({ signalHandlers: false })
    expect(() => app.use(new ProbeProvider('x'))).toThrow(/cannot add provider/i)
  })

  test('useProviders after start throws', async () => {
    const app = new Application()
    await app.start({ signalHandlers: false })
    expect(() => app.useProviders([new ProbeProvider('x')])).toThrow(/cannot add providers/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Boot ordering — topological sort
// ─────────────────────────────────────────────────────────────────────────────

describe('boot order', () => {
  test('no deps: providers boot in registration order', async () => {
    const app = new Application()
    const order: string[] = []
    const make = (name: string) => {
      const p = new ProbeProvider(name)
      p.boot = async () => {
        order.push(name)
      }
      return p
    }
    app.useProviders([make('a'), make('b'), make('c')])
    await app.start({ signalHandlers: false })
    expect(order).toEqual(['a', 'b', 'c'])
  })

  test('deps: dependent boots after its dependency', async () => {
    const app = new Application()
    const order: string[] = []
    const make = (name: string, deps: string[] = []) => {
      const p = new ProbeProvider(name, deps)
      p.boot = async () => {
        order.push(name)
      }
      return p
    }
    // Register out of order; topo-sort must fix it.
    app.useProviders([make('http', ['config']), make('config')])
    await app.start({ signalHandlers: false })
    expect(order).toEqual(['config', 'http'])
  })

  test('register pass runs sync, before any boot', async () => {
    const app = new Application()
    const order: string[] = []
    const a = new ProbeProvider('a')
    const b = new ProbeProvider('b', ['a'])
    a.register = () => order.push('a:register')
    a.boot = async () => {
      order.push('a:boot')
    }
    b.register = () => order.push('b:register')
    b.boot = async () => {
      order.push('b:boot')
    }
    app.useProviders([a, b])
    await app.start({ signalHandlers: false })
    expect(order).toEqual(['a:register', 'b:register', 'a:boot', 'b:boot'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Topo-sort errors
// ─────────────────────────────────────────────────────────────────────────────

describe('topo-sort errors', () => {
  test('duplicate name throws at start', () => {
    const app = new Application()
    app.useProviders([new ProbeProvider('x'), new ProbeProvider('x')])
    expect(app.start({ signalHandlers: false })).rejects.toThrow(/duplicate provider name/i)
  })

  test('unknown dependency throws at start', () => {
    const app = new Application()
    app.useProviders([new ProbeProvider('x', ['missing'])])
    expect(app.start({ signalHandlers: false })).rejects.toThrow(
      /depends on "missing".*not registered/i,
    )
  })

  test('cyclic dependencies throw at start', () => {
    const app = new Application()
    app.useProviders([new ProbeProvider('a', ['b']), new ProbeProvider('b', ['a'])])
    expect(app.start({ signalHandlers: false })).rejects.toThrow(/circular dependency/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Boot rollback
// ─────────────────────────────────────────────────────────────────────────────

describe('boot rollback', () => {
  test('if a later provider boot fails, earlier ones are shut down in reverse', async () => {
    const a = new ProbeProvider('a')
    const b = new ProbeProvider('b', ['a'])
    const c = new ProbeProvider('c', ['b'], { bootError: new Error('c boot failed') })
    const app = new Application().useProviders([a, b, c])

    await expect(app.start({ signalHandlers: false })).rejects.toThrow('c boot failed')

    // a and b booted; rollback shuts them down in reverse (b then a).
    expect(a.calls).toEqual(['register', 'boot', 'shutdown'])
    expect(b.calls).toEqual(['register', 'boot', 'shutdown'])
    // c registered + attempted boot, but never reached shutdown
    expect(c.calls).toEqual(['register', 'boot'])
    expect(app.isBooted).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent start / shutdown
// ─────────────────────────────────────────────────────────────────────────────

describe('idempotency', () => {
  test('start twice is a no-op', async () => {
    const app = new Application()
    const p = new ProbeProvider('a')
    app.use(p)
    await app.start({ signalHandlers: false })
    await app.start({ signalHandlers: false })
    expect(p.calls).toEqual(['register', 'boot']) // not doubled
  })

  test('shutdown without start is a no-op', async () => {
    const app = new Application()
    await app.shutdown()
    // Nothing to assert besides "didn't throw"
    expect(app.isBooted).toBe(false)
  })

  test('shutdown twice is a no-op', async () => {
    const app = new Application()
    const p = new ProbeProvider('a')
    app.use(p)
    await app.start({ signalHandlers: false })
    await app.shutdown()
    await app.shutdown()
    expect(p.calls.filter((c) => c === 'shutdown')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown order + error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('shutdown', () => {
  test('runs providers in REVERSE boot order', async () => {
    const order: string[] = []
    const make = (name: string, deps: string[] = []) => {
      const p = new ProbeProvider(name, deps)
      p.shutdown = async () => {
        order.push(name)
      }
      return p
    }
    const app = new Application().useProviders([make('a'), make('b', ['a']), make('c', ['b'])])
    await app.start({ signalHandlers: false })
    await app.shutdown()
    expect(order).toEqual(['c', 'b', 'a'])
  })

  test('one provider throwing in shutdown does not stop the rest', async () => {
    const order: string[] = []
    const a = new ProbeProvider('a')
    const b = new ProbeProvider('b', ['a'])
    a.shutdown = async () => {
      order.push('a')
    }
    b.shutdown = async () => {
      order.push('b')
      throw new Error('b shutdown failed')
    }
    const app = new Application().useProviders([a, b])
    await app.start({ signalHandlers: false })

    // Silence the error log so test output stays clean.
    const errSpy = mock(() => {})
    const origError = console.error
    console.error = errSpy as unknown as typeof console.error
    try {
      await app.shutdown()
    } finally {
      console.error = origError
    }

    // b ran first (reverse order), threw; a still ran afterward.
    expect(order).toEqual(['b', 'a'])
    expect(errSpy).toHaveBeenCalled()
  })

  test('container cache is disposed on shutdown', async () => {
    @inject()
    class S {}
    const app = new Application().singleton(S)
    await app.start({ signalHandlers: false })
    const before = app.resolve(S)
    await app.shutdown()
    // After shutdown, dispose clears cached singletons.
    // Re-resolve produces a new instance because the cache was cleared.
    const after = app.resolve(S)
    expect(after).not.toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle events
// ─────────────────────────────────────────────────────────────────────────────

describe('lifecycle events', () => {
  test('emits app:starting, app:booted in order', async () => {
    const app = new Application()
    const order: string[] = []
    app.events.on('app:starting', () => {
      order.push('starting')
    })
    app.events.on('app:booted', () => {
      order.push('booted')
    })
    await app.start({ signalHandlers: false })
    expect(order).toEqual(['starting', 'booted'])
  })

  test('emits app:shutdown, app:terminated in order', async () => {
    const app = new Application()
    const order: string[] = []
    app.events.on('app:shutdown', () => {
      order.push('shutdown')
    })
    app.events.on('app:terminated', () => {
      order.push('terminated')
    })
    await app.start({ signalHandlers: false })
    await app.shutdown()
    expect(order).toEqual(['shutdown', 'terminated'])
  })

  test('onBooted is a shorthand for once("app:booted")', async () => {
    const app = new Application()
    let booted = false
    app.onBooted(() => {
      booted = true
    })
    await app.start({ signalHandlers: false })
    expect(booted).toBe(true)
  })

  test('app:booted is NOT emitted when boot fails', async () => {
    let bootedFired = false
    const app = new Application().use(new ProbeProvider('x', [], { bootError: new Error('nope') }))
    app.events.on('app:booted', () => {
      bootedFired = true
    })
    await expect(app.start({ signalHandlers: false })).rejects.toThrow('nope')
    expect(bootedFired).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Signal handlers
// ─────────────────────────────────────────────────────────────────────────────

describe('signal handlers', () => {
  test('default: installs SIGINT + SIGTERM handlers', async () => {
    const captured: NodeJS.Signals[] = []
    process.on = ((signal: NodeJS.Signals, handler: NodeJS.SignalsListener) => {
      captured.push(signal)
      installed.push({ signal, handler })
      return process
    }) as typeof process.on

    try {
      const app = new Application()
      await app.start()
      expect(captured).toEqual(['SIGINT', 'SIGTERM'])
    } finally {
      process.on = origOn
    }
  })

  test('signalHandlers: false → no handlers installed', async () => {
    const captured: NodeJS.Signals[] = []
    process.on = ((signal: NodeJS.Signals, handler: NodeJS.SignalsListener) => {
      captured.push(signal)
      installed.push({ signal, handler })
      return process
    }) as typeof process.on

    try {
      const app = new Application()
      await app.start({ signalHandlers: false })
      expect(captured).toEqual([])
    } finally {
      process.on = origOn
    }
  })

  test('shutdown removes installed signal handlers', async () => {
    const onCalls: NodeJS.Signals[] = []
    const offCalls: NodeJS.Signals[] = []
    process.on = ((signal: NodeJS.Signals, handler: NodeJS.SignalsListener) => {
      onCalls.push(signal)
      installed.push({ signal, handler })
      return process
    }) as typeof process.on
    process.off = ((signal: NodeJS.Signals, _handler: NodeJS.SignalsListener) => {
      offCalls.push(signal)
      return process
    }) as typeof process.off

    try {
      const app = new Application()
      await app.start()
      await app.shutdown()
      expect(onCalls).toEqual(['SIGINT', 'SIGTERM'])
      expect(offCalls).toEqual(['SIGINT', 'SIGTERM'])
    } finally {
      process.on = origOn
      process.off = origOff
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Environment helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('environment helpers', () => {
  test('env() reads APP_ENV', () => {
    const app = new Application()
    const original = process.env.APP_ENV
    try {
      process.env.APP_ENV = 'staging'
      expect(app.env()).toBe('staging')
      expect(app.isStaging()).toBe(true)
      expect(app.isProduction()).toBe(false)

      process.env.APP_ENV = 'production'
      expect(app.isProduction()).toBe(true)

      process.env.APP_ENV = 'local'
      expect(app.isLocal()).toBe(true)

      process.env.APP_ENV = 'testing'
      expect(app.isTesting()).toBe(true)
    } finally {
      if (original === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = original
    }
  })

  test('env(check) returns boolean', () => {
    const app = new Application()
    const original = process.env.APP_ENV
    try {
      process.env.APP_ENV = 'production'
      expect(app.env('production')).toBe(true)
      expect(app.env('local')).toBe(false)
    } finally {
      if (original === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = original
    }
  })

  test('env() defaults to production when APP_ENV is unset', () => {
    const app = new Application()
    const original = process.env.APP_ENV
    delete process.env.APP_ENV
    try {
      expect(app.env()).toBe('production')
    } finally {
      if (original !== undefined) process.env.APP_ENV = original
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Application IS a Container
// ─────────────────────────────────────────────────────────────────────────────

describe('Application extends Container', () => {
  test('bindings registered on the app are resolvable', () => {
    @inject()
    class Db {}
    const app = new Application().singleton(Db)
    expect(app.resolve(Db)).toBe(app.resolve(Db))
  })

  test('createScope works on the application', () => {
    @inject()
    class Req {}
    const app = new Application().scoped(Req)
    const scope = app.createScope()
    expect(scope.resolve(Req)).toBeInstanceOf(Req)
  })
})
