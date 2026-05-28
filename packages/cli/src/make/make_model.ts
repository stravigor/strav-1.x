/**
 * `make:model <Name>` — the model_generator.
 *
 * Writes three files (each skipped if it already exists):
 *   - `app/models/<name>.ts`            — Model class
 *   - `app/repositories/<name>_repository.ts` — Repository<Model>
 *   - `database/factories/<name>_factory.ts`  — Factory stub
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Command, type ExecuteArgs } from '../command.ts'
import { ExitCode } from '../exit_codes.ts'
import { camel, pascal, snake } from '../make_command.ts'

export class MakeModel extends Command {
  static signature = 'make:model {name}'
  static description = 'Create Model + Repository + Factory stubs (model_generator).'
  static providers: string[] = []

  override async execute({ args }: ExecuteArgs): Promise<number> {
    const raw = (args.name ?? '').trim()
    if (!raw) {
      this.error('A model name is required.')
      return ExitCode.UsageError
    }

    const name = pascal(raw)
    const files: Array<{ path: string; content: string }> = [
      { path: `app/models/${snake(raw)}.ts`, content: modelStub(name) },
      {
        path: `app/repositories/${snake(raw)}_repository.ts`,
        content: repositoryStub(name),
      },
      {
        path: `database/factories/${snake(raw)}_factory.ts`,
        content: factoryStub(name),
      },
    ]

    for (const { path, content } of files) {
      const dest = join(process.cwd(), path)
      if (existsSync(dest)) {
        this.warn(`${dest} already exists — skipping.`)
        continue
      }
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, content, 'utf8')
      this.success(`Created ${dest}`)
    }
    return ExitCode.Success
  }
}

function modelStub(name: string): string {
  return `import { Model } from '@strav/database'

export class ${name} extends Model {
  declare id: string
  // add your properties here
}
`
}

function repositoryStub(name: string): string {
  return `import { inject } from '@strav/kernel'
import { PostgresDatabase, Repository } from '@strav/database'
import { ${name} } from '../models/${snake(name)}.ts'
import { ${camel(name)}Schema } from '../../database/schemas/${snake(name)}_schema.ts'

@inject()
export class ${name}Repository extends Repository<${name}> {
  constructor(db: PostgresDatabase) {
    super(db, ${camel(name)}Schema)
  }
}
`
}

function factoryStub(name: string): string {
  return `import type { ${name} } from '../../app/models/${snake(name)}.ts'

export function ${camel(name)}Factory(overrides: Partial<${name}> = {}): ${name} {
  return {
    // define default attribute values here
    ...overrides,
  } as ${name}
}
`
}
