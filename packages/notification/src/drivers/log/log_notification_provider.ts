/**
 * ServiceProvider that registers the log-channel factory on the
 * `NotificationManager`. Apps include this in their provider list
 * AFTER `NotificationProvider`; the factory then resolves whenever
 * `config.notification.channels.<name>.driver === 'log'`.
 */

import { type Application, Logger, ServiceProvider } from '@strav/kernel'
import { NotificationManager } from '../../notification_manager.ts'
import type { LogChannelConfig } from './log_config.ts'
import { LogNotificationDriver } from './log_notification_driver.ts'

export class LogNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.log'
  override readonly dependencies = ['notification', 'logger']

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    const logger = app.resolve(Logger)
    manager.extend('log', ({ instanceName, config }) => {
      const cfg = config as LogChannelConfig
      return new LogNotificationDriver({
        name: instanceName,
        logger,
        ...(cfg.level ? { level: cfg.level } : {}),
      })
    })
  }
}
