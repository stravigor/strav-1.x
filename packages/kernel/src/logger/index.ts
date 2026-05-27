// logger subsystem — public exports.

export { LogManager } from './log_manager.ts'
export { type ChannelResolver, Logger } from './logger.ts'
export { compileRedactor, type Redactor, type RedactorOptions } from './redact.ts'
export type {
  ChannelConfig,
  DailyChannelConfig,
  LogFields,
  LoggerConfig,
  LogLevel,
  RedactConfig,
  SingleChannelConfig,
  StackChannelConfig,
  StderrChannelConfig,
  SyslogChannelConfig,
} from './types.ts'
