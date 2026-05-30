// Public API of @strav/notification.
//
// V1: NotificationManager facade + NotificationDriver interface +
// BaseNotification abstract class + Notifiable interface + channel
// drivers under subpaths (./mail, ./database, ./log, ./webhook,
// ./broadcast, ./discord, ./sse). SMS channel follows in a later slice.

export {
  MockNotificationDriver,
  type MockNotificationRecord,
  mockNotificationDriverFactory,
} from './drivers/mock.ts'
export type { Notifiable } from './notifiable.ts'
export { BaseNotification } from './notification.ts'
export type {
  ChannelConfig,
  NotificationConfig,
} from './notification_config.ts'
export type {
  NotificationDriver,
  NotificationDriverFactory,
} from './notification_driver.ts'
export {
  NotificationConfigError,
  NotificationDeliveryError,
  NotificationError,
  UnknownChannelError,
} from './notification_error.ts'
export {
  NotificationManager,
  type NotificationManagerOptions,
} from './notification_manager.ts'
export { NotificationProvider } from './notification_provider.ts'
export type {
  NotificationContext,
  NotificationDeliveryResult,
  NotificationDispatchResult,
} from './types.ts'
