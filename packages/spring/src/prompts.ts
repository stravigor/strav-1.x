/**
 * Minimal interactive prompts for `bunx @strav/spring`. Two functions:
 * `select` for picking from a small fixed list, `input` for a free string.
 *
 * No external dependency: spring's whole point is to bootstrap a project
 * with `bunx` and a pinned framework version — we don't want a chain of
 * peer deps to install before the user has typed their first thing.
 *
 * Tested through the bin (not unit-tested) because the value here is the
 * interactive I/O surface, not the parsing.
 */

import * as readline from 'node:readline/promises'

export interface SelectOption<T extends string> {
  value: T
  label: string
  description?: string
}

export async function select<T extends string>(
  question: string,
  options: readonly SelectOption<T>[],
): Promise<T> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    process.stdout.write(`\n  ${question}\n`)
    for (let i = 0; i < options.length; i++) {
      const opt = options[i] as SelectOption<T>
      const tail = opt.description ? `  \x1b[2m— ${opt.description}\x1b[0m` : ''
      process.stdout.write(`    \x1b[2m${i + 1})\x1b[0m ${opt.label}${tail}\n`)
    }
    while (true) {
      const answer = (await rl.question(`\n  > `)).trim()
      const numeric = Number.parseInt(answer, 10)
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
        return (options[numeric - 1] as SelectOption<T>).value
      }
      const match = options.find((o) => o.value === answer || o.label === answer)
      if (match) return match.value
      process.stdout.write(`  \x1b[31m✗\x1b[0m enter a number 1–${options.length} or the label\n`)
    }
  } finally {
    rl.close()
  }
}

export async function input(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = fallback !== undefined ? ` \x1b[2m(${fallback})\x1b[0m` : ''
    const answer = (await rl.question(`  ${question}${suffix}: `)).trim()
    return answer === '' && fallback !== undefined ? fallback : answer
  } finally {
    rl.close()
  }
}
