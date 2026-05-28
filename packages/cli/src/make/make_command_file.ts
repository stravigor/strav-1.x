import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeCommandFile extends MakeCommand {
  static signature = 'make:command {name}'
  static description = 'Create a console Command stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `app/console/commands/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name)
    return `import { Command, type ExecuteArgs, ExitCode } from '@strav/cli'

export class ${cls} extends Command {
  static signature = '${snake(name).replace(/_/g, ':')}'
  static description = 'Describe what this command does.'

  override async execute({ args, flags }: ExecuteArgs): Promise<number> {
    // implement the command here
    return ExitCode.Success
  }
}
`
  }
}
