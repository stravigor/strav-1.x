#!/usr/bin/env bun
/**
 * `bunx @strav/spring <project>` entry. Wires argv parsing → optional
 * interactive prompts → scaffold → `bun install`. Errors print to stderr
 * and exit non-zero; expected (`SpringError`) errors print without the
 * stack trace, unexpected ones include it.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs, type Template, toSnakeCase } from './args.ts'
import { input, select } from './prompts.ts'
import { scaffold } from './scaffold.ts'
import { SpringError } from './spring_error.ts'
import { STRAV_VERSION } from './version.ts'

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`

const SPRING_VERSION = '1.0.0-alpha.27'

function printUsage(): void {
  process.stdout.write(`
  ${bold('@strav/spring')} ${dim(`v${SPRING_VERSION}`)}
  ${dim('Strav project scaffolder')}

  ${bold('Usage:')}
    bunx @strav/spring ${cyan('<project-name>')} [options]

  ${bold('Options:')}
    --api                       Headless REST template
    --web                       Full-stack template ${dim('(pages auto-router + Vue islands)')}
    --template, -t ${dim('api|web')}      Alias for --api / --web
    --db ${dim('<name>')}                 Database name ${dim('(default: snake_case(project-name))')}
    --no-install                Skip ${dim('bun install')} after scaffolding
    -v, --version               Print spring version and exit
    -h, --help                  Show this help and exit

  ${bold('Examples:')}
    bunx @strav/spring my-api --api
    bunx @strav/spring my-app                 ${dim('# interactive prompt')}
    bunx @strav/spring my-app --api --no-install
`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printUsage()
    return 0
  }
  if (args.version) {
    process.stdout.write(`${SPRING_VERSION}\n`)
    return 0
  }
  if (args.projectName === undefined) {
    printUsage()
    return 1
  }

  const dest = resolve(args.projectName)
  if (existsSync(dest)) {
    throw new SpringError(`directory already exists: ${dest}`)
  }

  process.stdout.write(`\n  ${bold('@strav/spring')} ${dim(`v${SPRING_VERSION}`)}\n`)
  process.stdout.write(`  ${dim('Scaffolding a Strav app')}\n`)

  let template: Template
  if (args.template !== undefined) {
    template = args.template
  } else {
    template = await select<Template>('Which template?', [
      { value: 'api', label: 'api', description: 'Headless REST template' },
      {
        value: 'web',
        label: 'web',
        description: 'Full-stack — pages auto-router + Vue islands + plain CSS',
      },
    ])
  }

  const dbName = args.dbName ?? (await input('Database name', toSnakeCase(args.projectName)))

  process.stdout.write('\n')
  const result = await scaffold({
    projectName: args.projectName,
    template,
    dbName,
    dest,
    stravVersion: STRAV_VERSION,
  })
  process.stdout.write(`  ${green('+')} wrote ${result.files.length} files into ${dest}\n`)

  if (!args.noInstall) {
    process.stdout.write(`  ${dim('…')} installing dependencies\n`)
    const proc = Bun.spawn(['bun', 'install'], {
      cwd: dest,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new SpringError(`bun install failed (exit ${code}):\n${stderr}`)
    }
    process.stdout.write(`  ${green('+')} installed dependencies\n`)
  } else {
    process.stdout.write(`  ${dim('-')} skipped install (--no-install)\n`)
  }

  process.stdout.write(`\n  ${green('Done!')} Next steps:\n\n`)
  process.stdout.write(`    ${dim('$')} cd ${args.projectName}\n`)
  if (args.noInstall) process.stdout.write(`    ${dim('$')} bun install\n`)
  process.stdout.write(`    ${dim('$')} bun strav serve\n\n`)
  process.stdout.write(`  ${dim('Then open http://localhost:3000')}\n\n`)
  return 0
}

try {
  process.exit(await main())
} catch (err) {
  if (err instanceof SpringError) {
    process.stderr.write(`\n  ${red('✗')} ${err.message}\n\n`)
    process.exit(1)
  }
  process.stderr.write(`\n  ${red('✗ internal error')}\n`)
  process.stderr.write(`  ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n\n`)
  process.exit(1)
}
