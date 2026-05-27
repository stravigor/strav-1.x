import { describe, expect, test } from 'bun:test'
import {
  Command,
  type CommandClass,
  type CommandContext,
  ConsoleKernel,
  ConsoleOutput,
} from '../src/console/index.ts'
import { Application } from '../src/core/application.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Test stream + output helpers
// ─────────────────────────────────────────────────────────────────────────────

class MemStream {
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

function makeKernel(commands: CommandClass[] = []): {
  app: Application
  kernel: ConsoleKernel
  stdout: MemStream
  stderr: MemStream
} {
  const app = new Application()
  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  const kernel = new ConsoleKernel(app, out)
  if (commands.length > 0) kernel.register(...commands)
  return { app, kernel, stdout, stderr }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample commands
// ─────────────────────────────────────────────────────────────────────────────

class HelloCommand extends Command {
  static readonly signature = 'hello'
  static readonly description = 'Print hello world'

  async handle(ctx: CommandContext): Promise<void> {
    ctx.out.line(`hello ${ctx.args[0] ?? 'world'}`)
  }
}

class FailCommand extends Command {
  static readonly signature = 'fail'
  static readonly description = 'Always throws'

  async handle(): Promise<void> {
    throw new Error('something went wrong')
  }
}

class ExitCommand extends Command {
  static readonly signature = 'exit'
  static readonly description = 'Returns a specific exit code'

  async handle(ctx: CommandContext): Promise<number> {
    return Number.parseInt(ctx.args[0] ?? '0', 10)
  }
}

class FlagsCommand extends Command {
  static readonly signature = 'flags'
  static readonly description = 'Echoes parsed flags'

  async handle(ctx: CommandContext): Promise<void> {
    ctx.out.line(JSON.stringify(ctx.flags))
  }
}

class MakeControllerCommand extends Command {
  static readonly signature = 'make:controller'
  static readonly description = 'Generate a controller stub'

  async handle(ctx: CommandContext): Promise<void> {
    ctx.out.line(`generated controller ${ctx.args[0] ?? '<unnamed>'}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// register()
// ─────────────────────────────────────────────────────────────────────────────

describe('ConsoleKernel.register', () => {
  test('records the command class by its static signature', () => {
    const { kernel } = makeKernel([HelloCommand])
    expect(kernel.commands()).toEqual([HelloCommand])
  })

  test('returns this (chainable)', () => {
    const { kernel } = makeKernel()
    expect(kernel.register(HelloCommand)).toBe(kernel)
  })

  test('rejects a class missing the static `signature` field', () => {
    const { kernel } = makeKernel()
    class Bad extends Command {
      async handle(): Promise<void> {}
    }
    expect(() => kernel.register(Bad as unknown as CommandClass)).toThrow(
      /missing static `signature`/,
    )
  })

  test('rejects duplicate signatures', () => {
    const { kernel } = makeKernel([HelloCommand])
    class HelloTwo extends Command {
      static readonly signature = 'hello'
      static readonly description = 'duplicate'
      async handle(): Promise<void> {}
    }
    expect(() => kernel.register(HelloTwo)).toThrow(/registered twice/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// handle() — listing / unknown / dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe('ConsoleKernel.handle — listing', () => {
  test('empty argv prints the list (exit 0)', async () => {
    const { kernel, stdout } = makeKernel([HelloCommand, MakeControllerCommand])
    const code = await kernel.handle([])
    expect(code).toBe(0)
    expect(stdout.text()).toContain('Available commands:')
    expect(stdout.text()).toContain('hello')
    expect(stdout.text()).toContain('make:controller')
  })

  test('explicit "list" prints the list', async () => {
    const { kernel, stdout } = makeKernel([HelloCommand])
    expect(await kernel.handle(['list'])).toBe(0)
    expect(stdout.text()).toContain('Available commands:')
  })

  test('"--help" and "-h" also print the list', async () => {
    const a = makeKernel([HelloCommand])
    const b = makeKernel([HelloCommand])
    expect(await a.kernel.handle(['--help'])).toBe(0)
    expect(await b.kernel.handle(['-h'])).toBe(0)
    expect(a.stdout.text()).toContain('Available commands:')
    expect(b.stdout.text()).toContain('Available commands:')
  })

  test('empty registry: list is informative', async () => {
    const { kernel, stdout } = makeKernel()
    await kernel.handle([])
    expect(stdout.text()).toContain('(none registered)')
  })

  test('list is sorted', async () => {
    const { kernel, stdout } = makeKernel([MakeControllerCommand, HelloCommand, ExitCommand])
    await kernel.handle([])
    const text = stdout.text()
    const helloIdx = text.indexOf('hello')
    const makeIdx = text.indexOf('make:controller')
    const exitIdx = text.indexOf('exit')
    expect(exitIdx).toBeLessThan(helloIdx)
    expect(helloIdx).toBeLessThan(makeIdx)
  })
})

describe('ConsoleKernel.handle — unknown command', () => {
  test('returns 1 and writes to stderr', async () => {
    const { kernel, stdout, stderr } = makeKernel([HelloCommand])
    const code = await kernel.handle(['nope'])
    expect(code).toBe(1)
    expect(stderr.text()).toContain('Unknown command "nope"')
    // Error should NOT be on stdout
    expect(stdout.text()).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// handle() — successful dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe('ConsoleKernel.handle — dispatch', () => {
  test('runs the command and returns 0 on void return', async () => {
    const { app, kernel, stdout } = makeKernel([HelloCommand])
    await app.start({ signalHandlers: false })
    const code = await kernel.handle(['hello'])
    expect(code).toBe(0)
    expect(stdout.text()).toBe('hello world\n')
    await app.shutdown()
  })

  test('passes positional args to the command', async () => {
    const { app, kernel, stdout } = makeKernel([HelloCommand])
    await app.start({ signalHandlers: false })
    await kernel.handle(['hello', 'alice'])
    expect(stdout.text()).toBe('hello alice\n')
    await app.shutdown()
  })

  test('passes parsed flags to the command', async () => {
    const { app, kernel, stdout } = makeKernel([FlagsCommand])
    await app.start({ signalHandlers: false })
    await kernel.handle(['flags', '--port=3000', '--verbose'])
    expect(JSON.parse(stdout.text())).toEqual({ port: '3000', verbose: true })
    await app.shutdown()
  })

  test('numeric return value is the exit code', async () => {
    const { app, kernel } = makeKernel([ExitCommand])
    await app.start({ signalHandlers: false })
    expect(await kernel.handle(['exit', '42'])).toBe(42)
    expect(await kernel.handle(['exit', '0'])).toBe(0)
    await app.shutdown()
  })

  test('command with a colon name dispatches correctly', async () => {
    const { app, kernel, stdout } = makeKernel([MakeControllerCommand])
    await app.start({ signalHandlers: false })
    await kernel.handle(['make:controller', 'UserController'])
    expect(stdout.text()).toBe('generated controller UserController\n')
    await app.shutdown()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// handle() — error paths
// ─────────────────────────────────────────────────────────────────────────────

describe('ConsoleKernel.handle — error paths', () => {
  test('thrown error → exit 1, message on stderr', async () => {
    const { app, kernel, stdout, stderr } = makeKernel([FailCommand])
    await app.start({ signalHandlers: false })
    const code = await kernel.handle(['fail'])
    expect(code).toBe(1)
    expect(stdout.text()).toBe('')
    expect(stderr.text()).toContain('ServerError') // wrapped via asStravError
    expect(stderr.text()).toContain('something went wrong')
    await app.shutdown()
  })

  test('non-production env surfaces a stack trace to stderr', async () => {
    const prevEnv = process.env.APP_ENV
    process.env.APP_ENV = 'local'
    const { app, kernel, stderr } = makeKernel([FailCommand])
    await app.start({ signalHandlers: false })
    await kernel.handle(['fail'])
    expect(stderr.text()).toContain('at ')
    await app.shutdown()
    if (prevEnv === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = prevEnv
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// static run()
// ─────────────────────────────────────────────────────────────────────────────

describe('ConsoleKernel.run', () => {
  test('builds an app, boots it, dispatches, shuts it down', async () => {
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await ConsoleKernel.run({
      argv: ['hello', 'world'],
      commands: [HelloCommand],
      output: {
        stdout: stdout as unknown as NodeJS.WritableStream,
        stderr: stderr as unknown as NodeJS.WritableStream,
        useColor: false,
      },
    })
    expect(code).toBe(0)
    expect(stdout.text()).toBe('hello world\n')
  })

  test('accepts a pre-built Application', async () => {
    const app = new Application()
    const stdout = new MemStream()
    const code = await ConsoleKernel.run({
      argv: ['hello'],
      app,
      commands: [HelloCommand],
      output: {
        stdout: stdout as unknown as NodeJS.WritableStream,
        stderr: new MemStream() as unknown as NodeJS.WritableStream,
        useColor: false,
      },
    })
    expect(code).toBe(0)
    expect(stdout.text()).toBe('hello world\n')
    // App was started and shut down by run()
    expect(app.isBooted).toBe(false)
  })

  test('shuts the app down even when the command throws', async () => {
    const app = new Application()
    const code = await ConsoleKernel.run({
      argv: ['fail'],
      app,
      commands: [FailCommand],
      output: {
        stdout: new MemStream() as unknown as NodeJS.WritableStream,
        stderr: new MemStream() as unknown as NodeJS.WritableStream,
        useColor: false,
      },
    })
    expect(code).toBe(1)
    expect(app.isBooted).toBe(false)
  })

  test('propagates the numeric exit code from the command', async () => {
    const code = await ConsoleKernel.run({
      argv: ['exit', '7'],
      commands: [ExitCommand],
      output: {
        stdout: new MemStream() as unknown as NodeJS.WritableStream,
        stderr: new MemStream() as unknown as NodeJS.WritableStream,
        useColor: false,
      },
    })
    expect(code).toBe(7)
  })

  test('returns 1 on boot failure (and does not leave the app booted)', async () => {
    class BadProvider {
      readonly name = 'bad'
      readonly dependencies: readonly string[] = []
      register(): void {}
      async boot(): Promise<void> {
        throw new Error('boot exploded')
      }
      async shutdown(): Promise<void> {}
    }
    const app = new Application()
    const stderr = new MemStream()
    const code = await ConsoleKernel.run({
      argv: ['hello'],
      app,
      providers: [new BadProvider()],
      commands: [HelloCommand],
      output: {
        stdout: new MemStream() as unknown as NodeJS.WritableStream,
        stderr: stderr as unknown as NodeJS.WritableStream,
        useColor: false,
      },
    })
    expect(code).toBe(1)
    expect(stderr.text()).toContain('boot exploded')
    expect(app.isBooted).toBe(false)
  })
})
