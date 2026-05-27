/**
 * Stderr destination — JSON lines straight to `process.stderr` by default,
 * with an opt-in `pretty: true` formatter for local development.
 */

import type { LogDestination } from './destination.ts'
import { formatPretty } from './pretty.ts'

export interface StderrDestinationOptions {
  pretty?: boolean
}

export function stderrDestination(options: StderrDestinationOptions = {}): LogDestination {
  const stream = process.stderr
  if (options.pretty !== true) {
    return {
      write(line: string): void {
        stream.write(line)
      },
    }
  }
  return {
    write(line: string): void {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        stream.write(`${formatPretty(obj)}\n`)
      } catch {
        stream.write(line)
      }
    },
  }
}
