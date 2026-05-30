/**
 * ServiceProvider that registers the webhook-channel factory on the
 * `NotificationManager`. Apps include this in their provider list
 * AFTER `NotificationProvider`; the factory then resolves whenever
 * `config.notification.channels.<name>.driver === 'webhook'`.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { NotificationConfigError } from '../../notification_error.ts'
import { NotificationManager } from '../../notification_manager.ts'
import type { WebhookChannelConfig } from './webhook_config.ts'
import { WebhookNotificationDriver } from './webhook_notification_driver.ts'

export class WebhookNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.webhook'
  override readonly dependencies = ['notification']

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    manager.extend('webhook', ({ instanceName, config }) => {
      const cfg = config as WebhookChannelConfig
      if (!cfg.endpoint) {
        throw new NotificationConfigError(
          `WebhookNotificationProvider: channel "${instanceName}" requires a non-empty \`endpoint\`.`,
          { context: { channel: instanceName } },
        )
      }
      if (!cfg.secret) {
        throw new NotificationConfigError(
          `WebhookNotificationProvider: channel "${instanceName}" requires a non-empty \`secret\`.`,
          { context: { channel: instanceName } },
        )
      }
      return new WebhookNotificationDriver({
        name: instanceName,
        endpoint: cfg.endpoint,
        secret: cfg.secret,
        ...(cfg.algorithm !== undefined ? { algorithm: cfg.algorithm } : {}),
        ...(cfg.headers !== undefined ? { headers: cfg.headers } : {}),
        ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      })
    })
  }
}
