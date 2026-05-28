import { MakeCommand, snake } from '../make_command.ts'

export class MakeTest extends MakeCommand {
  static signature = 'make:test {name}'
  static description = 'Create a feature test stub.'
  static providers: string[] = []

  protected filePath(name: string): string {
    return `tests/feature/${snake(name)}.test.ts`
  }

  protected stub(name: string): string {
    return `import { describe, expect, test } from 'bun:test'

describe('${snake(name).replace(/_/g, ' ')}', () => {
  test('placeholder', () => {
    expect(true).toBe(true)
  })
})
`
  }
}
