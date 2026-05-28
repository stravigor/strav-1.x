/**
 * `bun strav console` — interactive REPL with the booted app in scope.
 *
 * Uses Node.js's built-in `node:repl` module, which works in Bun.
 * The booted `Application` is exposed as the global `app` in the REPL
 * context, so operators can inspect bindings, resolve services, and
 * run ad-hoc queries without writing a script file.
 *
 * Exit the REPL with `.exit`, Ctrl-D (EOF), or Ctrl-C twice.
 */

import * as nodeRepl from 'node:repl'
import { Command, ExitCode } from '@strav/cli'

export class Console extends Command {
  static signature = 'console'
  static description = 'Start an interactive REPL with the booted app in scope.'

  override async execute(): Promise<number> {
    this.line(`Strav console — app is available as \`app\`.`)
    this.line()

    const server = nodeRepl.start({
      prompt: '> ',
      useGlobal: false,
    })

    // Expose the booted Application as a global in the REPL context.
    server.context.app = this.app

    return new Promise<number>((resolve) => {
      server.on('exit', () => resolve(ExitCode.Success))
    })
  }
}
