// console subsystem — public exports.

export { type ParsedArgv, parseArgv } from './argv.ts'
export { Command, type CommandClass, type CommandResult } from './command.ts'
export type { CommandContext } from './command_context.ts'
export { ConsoleKernel, type ConsoleRunOptions } from './console_kernel.ts'
export { ConsoleOutput, type ConsoleOutputOptions } from './console_output.ts'
