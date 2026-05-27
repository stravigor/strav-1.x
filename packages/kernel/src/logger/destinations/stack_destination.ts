/**
 * Stack destination — fans one log line out to multiple child destinations.
 * Errors from one child do not block the others.
 */

import type { LogDestination } from './destination.ts'

export function stackDestination(children: readonly LogDestination[]): LogDestination {
  return {
    write(line: string): void {
      for (const child of children) {
        try {
          child.write(line)
        } catch {
          // Best-effort fan-out: a broken sibling must not break the others.
        }
      }
    },
    async close(): Promise<void> {
      await Promise.all(
        children.map(async (child) => {
          if (child.close) await child.close()
        }),
      )
    },
  }
}
