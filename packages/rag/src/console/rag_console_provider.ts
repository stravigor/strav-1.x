/**
 * `RagConsoleProvider` — declares the rag console commands.
 *
 * Apps add it to `bootstrap/providers.ts` alongside `RagProvider`.
 * Separate provider (mirrors `QueueConsoleProvider`) so apps
 * that don't use the CLI don't pay the cost of resolving the
 * commands at boot.
 */

import { ConsoleProvider } from '@strav/cli'
import { RagFlush } from './rag_flush.ts'
import { RagList } from './rag_list.ts'
import { RagReindex } from './rag_reindex.ts'

export class RagConsoleProvider extends ConsoleProvider {
  override readonly name = 'console.rag'
  override readonly commands = [RagFlush, RagList, RagReindex] as const
}
