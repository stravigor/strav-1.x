import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeJob extends MakeCommand {
  static signature = 'make:job {name}'
  static description = 'Create a queue job stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `app/jobs/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name)
    return `import { Job, type JobContext } from '@strav/queue'

export class ${cls} extends Job<unknown> {
  static override readonly jobName = '${snake(name)}'

  async handle(ctx: JobContext<unknown>): Promise<void> {
    // handle the job
  }
}
`
  }
}
