import { describe, expect, test } from 'bun:test'
import { Application, ConfigError, ServiceProvider } from '@strav/kernel'
import { Command, type ExecuteArgs } from '../src/command.ts'
import { ConsoleProvider, collectCommands } from '../src/console_provider.ts'
import { runCli } from '../src/run_cli.ts'

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

let bootedNames: string[] = []

class TrackingProvider extends ServiceProvider {
  constructor(
    public override readonly name: string,
    public override readonly dependencies: readonly string[] = [],
  ) {
    super()
  }
  override boot(): void {
    bootedNames.push(this.name)
  }
}

class HelloCmd extends Command {
  static signature = 'hello {name?}'
  static description = 'Smoke test command'
  override execute({ args }: ExecuteArgs): number {
    this.info(`Hello, ${args.name ?? 'world'}`)
    return 0
  }
}

class FullAppCmd extends Command {
  static signature = 'full'
  static description = 'Boots full default list'
  // No `static providers` — boots everything.
  override execute(): number {
    return 0
  }
}

class SubsetCmd extends Command {
  static signature = 'subset'
  static description = 'Boots only logger (transitively config)'
  static providers = ['logger']
  override execute(): number {
    return 0
  }
}

class NoneCmd extends Command {
  static signature = 'none'
  static description = 'Boots no providers'
  static providers: readonly string[] = []
  override execute(): number {
    return 0
  }
}

class HelloProvider extends ConsoleProvider {
  override readonly name = 'console.hello'
  override readonly commands = [HelloCmd, FullAppCmd, SubsetCmd, NoneCmd] as const
}

function makeArgs(argv: string[]) {
  const stdout = new MemStream()
  const stderr = new MemStream()
  return {
    argv,
    output: {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      useColor: false,
    },
    stdout,
    stderr,
  }
}

describe('runCli — wiring', () => {
  test('happy path: parses argv, boots, dispatches to command', async () => {
    bootedNames = []
    const config = new TrackingProvider('config')
    const logger = new TrackingProvider('logger', ['config'])
    const consoleProvider = new HelloProvider()
    const a = makeArgs(['hello', 'Liva'])

    const exit = await runCli({
      argv: a.argv,
      defaultProviders: [config, logger, consoleProvider],
      output: a.output,
    })

    expect(exit).toBe(0)
    expect(a.stdout.text()).toContain('Hello, Liva')
  })

  test('omitted commands → collected from ConsoleProvider subclasses', async () => {
    const consoleProvider = new HelloProvider()
    expect(collectCommands([consoleProvider])).toHaveLength(4)
  })

  test('unknown command → exit 1 + stderr message', async () => {
    const consoleProvider = new HelloProvider()
    const a = makeArgs(['no-such-command'])
    const exit = await runCli({
      argv: a.argv,
      defaultProviders: [consoleProvider],
      output: a.output,
    })
    expect(exit).toBe(1)
    expect(a.stderr.text()).toContain('Unknown command')
  })
})

describe('runCli — subset boot', () => {
  test('no static providers → full list boots', async () => {
    bootedNames = []
    const config = new TrackingProvider('config')
    const logger = new TrackingProvider('logger', ['config'])
    const other = new TrackingProvider('other')
    const consoleProvider = new HelloProvider()
    const a = makeArgs(['full'])

    await runCli({
      argv: a.argv,
      defaultProviders: [config, logger, other, consoleProvider],
      output: a.output,
    })
    // All four boot. ConsoleProvider.boot is a no-op (no override).
    expect(new Set(bootedNames)).toEqual(new Set(['config', 'logger', 'other']))
  })

  test('static providers: [name] → only that + transitive deps', async () => {
    bootedNames = []
    const config = new TrackingProvider('config')
    const logger = new TrackingProvider('logger', ['config'])
    const other = new TrackingProvider('other')
    const consoleProvider = new HelloProvider()
    const a = makeArgs(['subset'])

    await runCli({
      argv: a.argv,
      defaultProviders: [config, logger, other, consoleProvider],
      output: a.output,
    })
    expect(new Set(bootedNames)).toEqual(new Set(['config', 'logger']))
    expect(bootedNames).not.toContain('other')
  })

  test('static providers: [] → no providers boot', async () => {
    bootedNames = []
    const config = new TrackingProvider('config')
    const consoleProvider = new HelloProvider()
    const a = makeArgs(['none'])

    await runCli({
      argv: a.argv,
      defaultProviders: [config, consoleProvider],
      output: a.output,
    })
    expect(bootedNames).toEqual([])
  })

  test('static providers references unknown name → ConfigError', async () => {
    class BadCmd extends Command {
      static signature = 'bad'
      static description = '_'
      static providers = ['definitely-not-real']
      override execute(): number {
        return 0
      }
    }
    class BadProvider extends ConsoleProvider {
      override readonly name = 'bad'
      override readonly commands = [BadCmd] as const
    }
    const a = makeArgs(['bad'])
    await expect(
      runCli({
        argv: a.argv,
        defaultProviders: [new BadProvider()],
        output: a.output,
      }),
    ).rejects.toBeInstanceOf(ConfigError)
  })
})

describe('runCli — duplicate command detection', () => {
  test('two commands with the same signature throw at registration', async () => {
    class A extends Command {
      static signature = 'dup'
      static description = '_'
      override execute(): number {
        return 0
      }
    }
    class B extends Command {
      static signature = 'dup'
      static description = '_'
      override execute(): number {
        return 0
      }
    }
    const a = makeArgs(['dup'])
    await expect(
      runCli({
        argv: a.argv,
        defaultProviders: [],
        commands: [A, B],
        output: a.output,
      }),
    ).rejects.toThrow(/declared twice/)
  })
})

describe('runCli — tests with a pre-built app', () => {
  test('caller can pass app pre-built and runCli runs against it', async () => {
    bootedNames = []
    const app = new Application()
    const tracker = new TrackingProvider('tracker')
    const consoleProvider = new HelloProvider()
    const a = makeArgs(['hello'])

    const exit = await runCli({
      argv: a.argv,
      app,
      defaultProviders: [tracker, consoleProvider],
      output: a.output,
    })
    expect(exit).toBe(0)
    // tracker booted because hello has no `static providers` (default = full list)
    expect(bootedNames).toEqual(['tracker'])
  })
})
