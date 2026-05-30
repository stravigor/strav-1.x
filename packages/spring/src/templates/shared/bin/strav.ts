#!/usr/bin/env bun
/**
 * Single entry point for every role. `ConsoleKernel` (via `runCli`) parses
 * the subcommand and resolves the right kernel — `serve` for `HttpKernel`,
 * `make:*` for one-shot scaffolders, etc. Add new commands by listing a
 * `ConsoleProvider` subclass in `bootstrap/providers.ts`; `runCli`
 * auto-collects their `commands` arrays.
 */

// `@strav/kernel` imports `reflect-metadata` internally; consumers don't need to.
import { runCli } from '@strav/cli'
import { createApp } from '../bootstrap/app.ts'
import { providers } from '../bootstrap/providers.ts'

const exitCode = await runCli({
  argv: process.argv.slice(2),
  defaultProviders: await providers(),
  app: createApp(),
})

process.exit(exitCode)
