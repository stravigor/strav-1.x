/**
 * ServiceProvider that registers the SSE-channel factory on the
 * `NotificationManager`. Apps include this in their provider list
 * AFTER `NotificationProvider`; the factory resolves whenever
 * `config.notification.channels.<name>.driver === 'sse'`.
 *
 * No peer dependencies — the driver is pure in-process.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { NotificationManager } from '../../notification_manager.ts'
import type { SSEChannelConfig } from './sse_config.ts'
import { SSENotificationDriver } from './sse_notification_driver.ts'

export class SSENotificationProvider extends ServiceProvider {
  override readonly name = 'notification.sse'
  override readonly dependencies = ['notification']

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    manager.extend('sse', ({ instanceName, config }) => {
      const cfg = config as SSEChannelConfig
      return new SSENotificationDriver({
        name: instanceName,
        ...(cfg.queueSize !== undefined ? { queueSize: cfg.queueSize } : {}),
      })
    })
  }
}
