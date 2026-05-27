import { describe, expect, test } from 'bun:test'

import { ConsoleOutput } from '../src/console/console_output.ts'

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

function makeOutput(useColor: boolean): {
  out: ConsoleOutput
  stdout: MemStream
  stderr: MemStream
} {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const out = new ConsoleOutput({
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    useColor,
  })
  return { out, stdout, stderr }
}

describe('ConsoleOutput — plain mode', () => {
  test('line() writes to stdout with newline', () => {
    const { out, stdout } = makeOutput(false)
    out.line('hello')
    expect(stdout.text()).toBe('hello\n')
  })

  test('line() with no argument writes empty line', () => {
    const { out, stdout } = makeOutput(false)
    out.line()
    expect(stdout.text()).toBe('\n')
  })

  test('info/success/warn produce plain text (no ANSI)', () => {
    const { out, stdout } = makeOutput(false)
    out.info('info')
    out.success('ok')
    out.warn('hmm')
    expect(stdout.text()).toBe('info\nok\nhmm\n')
  })

  test('error() routes to stderr, NOT stdout', () => {
    const { out, stdout, stderr } = makeOutput(false)
    out.error('boom')
    expect(stdout.text()).toBe('')
    expect(stderr.text()).toBe('boom\n')
  })

  test('write() / writeError() do not append a newline', () => {
    const { out, stdout, stderr } = makeOutput(false)
    out.write('a')
    out.write('b')
    out.writeError('!')
    expect(stdout.text()).toBe('ab')
    expect(stderr.text()).toBe('!')
  })
})

describe('ConsoleOutput — color mode', () => {
  test('info wraps with 34 (blue) escape', () => {
    const { out, stdout } = makeOutput(true)
    out.info('hi')
    expect(stdout.text()).toBe(`\u001b[34mhi\u001b[0m\n`)
  })

  test('success uses 32 (green)', () => {
    const { out, stdout } = makeOutput(true)
    out.success('ok')
    expect(stdout.text()).toContain('\u001b[32m')
  })

  test('warn uses 33 (yellow)', () => {
    const { out, stdout } = makeOutput(true)
    out.warn('eek')
    expect(stdout.text()).toContain('\u001b[33m')
  })

  test('error uses 31 (red) and is on stderr', () => {
    const { out, stdout, stderr } = makeOutput(true)
    out.error('no')
    expect(stdout.text()).toBe('')
    expect(stderr.text()).toContain('\u001b[31m')
    expect(stderr.text()).toContain('\u001b[0m')
  })

  test('plain line() is never colored', () => {
    const { out, stdout } = makeOutput(true)
    out.line('boring')
    expect(stdout.text()).toBe('boring\n')
  })
})
