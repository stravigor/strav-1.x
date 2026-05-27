import { describe, expect, test } from 'bun:test'

import { parseArgv } from '../src/console/argv.ts'

describe('parseArgv — empty / minimal', () => {
  test('empty argv yields no command, no args, no flags', () => {
    expect(parseArgv([])).toEqual({ command: undefined, args: [], flags: {} })
  })

  test('single positional becomes the command', () => {
    expect(parseArgv(['hello'])).toEqual({ command: 'hello', args: [], flags: {} })
  })

  test('multiple positionals: first is command, rest are args', () => {
    expect(parseArgv(['greet', 'alice', 'bob'])).toEqual({
      command: 'greet',
      args: ['alice', 'bob'],
      flags: {},
    })
  })
})

describe('parseArgv — flags', () => {
  test('bare --flag is boolean true', () => {
    expect(parseArgv(['run', '--quiet'])).toEqual({
      command: 'run',
      args: [],
      flags: { quiet: true },
    })
  })

  test('--flag=value form', () => {
    expect(parseArgv(['serve', '--port=3000'])).toEqual({
      command: 'serve',
      args: [],
      flags: { port: '3000' },
    })
  })

  test('--flag value form (next token consumed)', () => {
    expect(parseArgv(['serve', '--port', '3000'])).toEqual({
      command: 'serve',
      args: [],
      flags: { port: '3000' },
    })
  })

  test('--flag followed by another flag stays boolean', () => {
    expect(parseArgv(['run', '--quiet', '--verbose'])).toEqual({
      command: 'run',
      args: [],
      flags: { quiet: true, verbose: true },
    })
  })

  test('short -f flag is boolean true', () => {
    expect(parseArgv(['run', '-f'])).toEqual({
      command: 'run',
      args: [],
      flags: { f: true },
    })
  })

  test('--flag <token> form: token is consumed as value (even for the command name)', () => {
    // This is the established ambiguity — `--verbose run` reads as `--verbose=run`.
    // To put a flag BEFORE the command, use the unambiguous `--flag=value` form
    // or a bare `--flag --` separator.
    expect(parseArgv(['--verbose', 'run'])).toEqual({
      command: undefined,
      args: [],
      flags: { verbose: 'run' },
    })
  })

  test('boolean flag before command works with --flag=true', () => {
    expect(parseArgv(['--verbose=true', 'run'])).toEqual({
      command: 'run',
      args: [],
      flags: { verbose: 'true' },
    })
  })

  test('--flag=empty-string', () => {
    expect(parseArgv(['x', '--name='])).toEqual({
      command: 'x',
      args: [],
      flags: { name: '' },
    })
  })

  test('repeating a flag is last-wins', () => {
    expect(parseArgv(['x', '--port=3000', '--port=4000']).flags).toEqual({ port: '4000' })
  })
})

describe('parseArgv — `--` end-of-flags marker', () => {
  test('tokens after -- are treated as positional even when starting with -', () => {
    expect(parseArgv(['rsync', '--', '--source=/tmp', '-x'])).toEqual({
      command: 'rsync',
      args: ['--source=/tmp', '-x'],
      flags: {},
    })
  })

  test('flags before -- are still parsed', () => {
    expect(parseArgv(['rsync', '--verbose', '--', '--source=/tmp'])).toEqual({
      command: 'rsync',
      args: ['--source=/tmp'],
      flags: { verbose: true },
    })
  })
})

describe('parseArgv — kebab + colon command names', () => {
  test('accepts colons in command names', () => {
    expect(parseArgv(['make:controller', 'User'])).toEqual({
      command: 'make:controller',
      args: ['User'],
      flags: {},
    })
  })

  test('accepts kebab in command names', () => {
    expect(parseArgv(['db-seed'])).toEqual({
      command: 'db-seed',
      args: [],
      flags: {},
    })
  })
})

describe('parseArgv — edge cases', () => {
  test('lone `-` is a positional (treated as command name)', () => {
    expect(parseArgv(['-'])).toEqual({
      command: '-',
      args: [],
      flags: {},
    })
  })

  test('lone `--` ends flag parsing and produces no command', () => {
    expect(parseArgv(['--'])).toEqual({
      command: undefined,
      args: [],
      flags: {},
    })
  })

  test('negative numbers as values are captured by previous flag', () => {
    // Per the rule: value after --flag is consumed only if it doesn't start with `-`.
    // So `--offset -5` produces { offset: true } and `-5` is a separate bool flag.
    expect(parseArgv(['x', '--offset', '-5'])).toEqual({
      command: 'x',
      args: [],
      flags: { offset: true, '5': true },
    })
  })
})
