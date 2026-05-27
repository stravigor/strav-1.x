/**
 * `Command` is the abstract base every console command extends.
 *
 *   - The static `signature` is the command name (e.g. `'hello'` or
 *     `'make:controller'`); it's static so the kernel can read it
 *     without instantiating (commands may have `@inject()` deps that
 *     only the booted container can resolve).
 *   - The static `description` is the one-liner shown by `list`.
 *   - The instance `handle(ctx)` is the action; it may return an exit
 *     code (number) or void (→ 0).
 *
 * @see docs/kernel/api.md
 * @see docs/kernel/guides/console.md
 */

import type { Constructor } from '../core/types.ts'
import type { CommandContext } from './command_context.ts'

/**
 * Allowed return shapes for `Command.handle()`. `void` (sync or via async
 * Promise<void>) means "treat as exit code 0"; a number is the explicit exit
 * code; anything else is a programming error.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: void here correctly means "no exit code, treat as 0"
export type CommandResult = Promise<number | void> | number | void

export abstract class Command {
  abstract handle(ctx: CommandContext): CommandResult
}

/**
 * Constructor type a `ConsoleKernel` accepts. Combines the runtime constructor
 * (so the container can `make()` it) with the static metadata fields
 * (signature/description) the kernel reads at registration time.
 */
export type CommandClass<T extends Command = Command> = Constructor<T> & {
  readonly signature: string
  readonly description: string
}
