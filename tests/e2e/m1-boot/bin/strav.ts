#!/usr/bin/env bun
// `@strav/kernel` imports `reflect-metadata` internally — consumers don't need to.
import { ConsoleKernel } from '@strav/kernel'

import { HelloCommand } from '../app/Console/Commands/hello_command.ts'
import { createApp } from '../bootstrap/app.ts'

const exitCode = await ConsoleKernel.run({
  argv: process.argv.slice(2),
  app: createApp(),
  commands: [HelloCommand],
})

process.exit(exitCode)
