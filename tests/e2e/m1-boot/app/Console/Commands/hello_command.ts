// ConfigRepository must be a *value* import — emitDecoratorMetadata stores the
// runtime class reference on the constructor, and a type-only import erases it,
// leaving the container to resolve `Object` instead.
// biome-ignore lint/style/useImportType: see comment above
import { Command, type CommandContext, ConfigRepository, inject } from '@strav/kernel'

/**
 * Exercises the full M1 stack:
 *   - ConsoleKernel resolves the class via the container (@inject).
 *   - The container injects ConfigRepository (bound by ConfigProvider).
 *   - ConfigRepository was frozen on `app:booted`; `.get(...)` returns its value.
 *   - The command writes through the real ConsoleOutput to stdout.
 */
@inject()
export class HelloCommand extends Command {
  static readonly signature = 'hello'
  static readonly description = 'Print a greeting from the configured app'

  constructor(private readonly config: ConfigRepository) {
    super()
  }

  async handle(ctx: CommandContext): Promise<void> {
    const appName = this.config.get('app.name')
    const who = ctx.args[0] ?? 'world'
    ctx.out.line(`hello ${who} from ${appName}`)
  }
}
