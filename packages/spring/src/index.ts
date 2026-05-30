/**
 * Public barrel for `@strav/spring`. The package's primary surface is the
 * CLI (`bin: @strav/spring`); the exports here are the programmatic API
 * used by tests and any tool that wants to embed scaffolding.
 */

export { type ParsedArgs, parseArgs, type Template, toSnakeCase } from './args.ts'
export { type ScaffoldOptions, type ScaffoldResult, scaffold } from './scaffold.ts'
export { SpringError } from './spring_error.ts'
export { STRAV_VERSION } from './version.ts'
