/**
 * Single-file destination — every log line appended to one file. Suitable for
 * dev or for apps that ship their own rotation tooling (logrotate, etc.).
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { LogDestination } from './destination.ts'

export interface SingleDestinationOptions {
  /** Path to the log file. Relative paths resolve against `process.cwd()`. */
  path: string
}

export function singleDestination(options: SingleDestinationOptions): LogDestination {
  const path = isAbsolute(options.path) ? options.path : resolve(process.cwd(), options.path)
  mkdirSync(dirname(path), { recursive: true })
  const stream: WriteStream = createWriteStream(path, { flags: 'a' })

  return {
    write(line: string): void {
      stream.write(line)
    },
    close(): Promise<void> {
      return new Promise((resolveClose) => {
        stream.end(() => resolveClose())
      })
    },
  }
}
