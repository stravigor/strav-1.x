import { MakeCommand, pascal, snake } from '../make_command.ts'

export class MakeProvider extends MakeCommand {
  static signature = 'make:provider {name}'
  static description = 'Create a ServiceProvider stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `app/providers/${snake(name)}.ts`
  }

  protected stub(name: string): string {
    const cls = pascal(name).endsWith('Provider') ? pascal(name) : `${pascal(name)}Provider`
    return `import { type Application, ServiceProvider } from '@strav/kernel'

export class ${cls} extends ServiceProvider {
  override readonly name = '${snake(cls).replace(/_provider$/, '')}'

  override register(app: Application): void {
    // bind services into the container
  }

  override async boot(app: Application): Promise<void> {
    // run initialization after all providers are registered
  }
}
`
  }
}
