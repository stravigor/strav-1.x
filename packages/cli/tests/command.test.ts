import { describe, expect, test } from 'bun:test'
import {
  Application,
  type CommandContext,
  ConfigError,
  ConsoleKernel,
  ConsoleOutput,
} from '@strav/kernel'
import { Command, type ExecuteArgs } from '../src/command.ts'

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

function buildCtx(args: string[] = [], flags: Record<string, string | boolean> = {}) {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor: false,
  })
  const ctx: CommandContext = { args, flags, out, app: new Application() }
  return { ctx, stdout, stderr }
}

class EchoCommand extends Command {
  static signature = 'echo {what} {--upper}'
  static description = 'Echo back the argument'

  override execute({ args, flags }: ExecuteArgs): number {
    const what = args.what ?? ''
    const out = flags.upper === true ? what.toUpperCase() : what
    this.info(out)
    return 0
  }
}

describe('Command — execute path', () => {
  test('binds positional + flag and calls execute()', async () => {
    const cmd = new EchoCommand()
    const { ctx, stdout } = buildCtx(['hello'], { upper: true })
    const exit = await cmd.handle(ctx)
    expect(exit).toBe(0)
    expect(stdout.text()).toContain('HELLO')
  })

  test('missing required positional → exit code 2 + stderr message', async () => {
    const cmd = new EchoCommand()
    const { ctx, stderr } = buildCtx([])
    const exit = await cmd.handle(ctx)
    expect(exit).toBe(2)
    expect(stderr.text()).toContain('missing argument: <what>')
    expect(stderr.text()).toContain('Usage: echo <what> [--upper]')
  })

  test('flag default is applied when absent', async () => {
    class WithDefault extends Command {
      static signature = 'cmd {--name=anon}'
      static description = '_'
      override execute({ flags }: ExecuteArgs): number {
        this.line(`hi ${flags.name}`)
        return 0
      }
    }
    const { ctx, stdout } = buildCtx([])
    await new WithDefault().handle(ctx)
    expect(stdout.text()).toBe('hi anon\n')
  })
})

describe('Command — per-command --help', () => {
  test('--help short-circuits to printHelp() before execute()', async () => {
    let executed = false
    class HelpCmd extends Command {
      static signature = 'help-me {target} {--out=storage/backups}'
      static description = 'Demo command'
      override execute(): number {
        executed = true
        return 0
      }
    }
    const { ctx, stdout } = buildCtx([], { help: true })
    const exit = await new HelpCmd().handle(ctx)
    expect(exit).toBe(0)
    expect(executed).toBe(false)
    const text = stdout.text()
    expect(text).toContain('Demo command')
    expect(text).toContain('Usage: help-me <target> [--out=…]')
    expect(text).toContain('--out=<value> (default: storage/backups)')
  })

  test('-h alias also triggers help', async () => {
    class ShortHelp extends Command {
      static signature = 'sh'
      static description = 'd'
      override execute(): number {
        throw new Error('should not run')
      }
    }
    const { ctx, stdout } = buildCtx([], { h: true })
    await new ShortHelp().handle(ctx)
    expect(stdout.text()).toContain('Usage: sh')
  })
})

describe('Command — output helpers', () => {
  test('info / warn / error route to the right stream', async () => {
    class Speak extends Command {
      static signature = 'speak'
      static description = '_'
      override execute(): number {
        this.info('blue')
        this.warn('yellow')
        this.error('red')
        return 0
      }
    }
    const { ctx, stdout, stderr } = buildCtx()
    await new Speak().handle(ctx)
    expect(stdout.text()).toContain('blue')
    expect(stdout.text()).toContain('yellow')
    expect(stderr.text()).toContain('red')
  })

  test('table() emits aligned columns', async () => {
    class TableCmd extends Command {
      static signature = 'tbl'
      static description = '_'
      override execute(): number {
        this.table(
          ['Slug', 'Name'],
          [
            ['acme', 'Acme'],
            ['x', 'Long Name'],
          ],
        )
        return 0
      }
    }
    const { ctx, stdout } = buildCtx()
    await new TableCmd().handle(ctx)
    const lines = stdout.text().trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^Slug\s+Name\s*$/)
    expect(lines[1]).toMatch(/^-{4}\s+-{9}\s*$/)
    expect(lines[2]).toMatch(/^acme\s+Acme\s*$/)
  })
})

describe('Command — missing signature', () => {
  test('throws when static signature is missing', async () => {
    class Bad extends Command {
      static description = 'no signature'
      override execute(): number {
        return 0
      }
    }
    const { ctx } = buildCtx()
    await expect(new Bad().handle(ctx)).rejects.toThrow(/missing static `signature`/)
  })
})

describe('ConsoleKernel integration — bind through dispatch', () => {
  test('kernel.handle() dispatches to the Command base which binds + executes', async () => {
    const app = new Application()
    const stdout = new MemStream()
    const stderr = new MemStream()
    const output = new ConsoleOutput({
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      useColor: false,
    })
    const kernel = new ConsoleKernel(app, output)
    kernel.register(EchoCommand)
    const exit = await kernel.handle(['echo', 'world'])
    expect(exit).toBe(0)
    expect(stdout.text()).toContain('world')
  })

  test('UsageError caught by the Command base → exit 2 + stderr message', async () => {
    const app = new Application()
    const stdout = new MemStream()
    const stderr = new MemStream()
    const output = new ConsoleOutput({
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      useColor: false,
    })
    const kernel = new ConsoleKernel(app, output)
    kernel.register(EchoCommand)
    const exit = await kernel.handle(['echo']) // missing {what}
    expect(exit).toBe(2)
    expect(stderr.text()).toContain('missing argument')
  })

  test('duplicate command signatures throw at registration', () => {
    const app = new Application()
    const output = new ConsoleOutput({
      stdout: new MemStream() as unknown as NodeJS.WritableStream,
      useColor: false,
    })
    const kernel = new ConsoleKernel(app, output)
    expect(() => kernel.register(EchoCommand, EchoCommand)).toThrow(ConfigError)
  })
})
