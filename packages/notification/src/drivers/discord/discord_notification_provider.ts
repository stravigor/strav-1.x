/**
 * ServiceProvider that registers the discord-channel factory on the
 * `NotificationManager`. Apps include this in their provider list
 * AFTER `NotificationProvider`; the factory resolves whenever
 * `config.notification.channels.<name>.driver === 'discord'`.
 *
 * Unlike the webhook channel, the Discord factory does NOT validate
 * `webhookUrl` upfront — apps can intentionally omit it and route
 * every dispatch via per-recipient (`notifiable.discordWebhookUrl`)
 * or per-message (`toDiscord` returning `{ webhookUrl }`) URLs. The
 * driver fails the dispatch (`delivered: false`) when none resolve.
 */

import { type Application, ServiceProvider } from '@strav/kernel'
import { NotificationManager } from '../../notification_manager.ts'
import type { DiscordChannelConfig } from './discord_config.ts'
import { DiscordNotificationDriver } from './discord_notification_driver.ts'

export class DiscordNotificationProvider extends ServiceProvider {
  override readonly name = 'notification.discord'
  override readonly dependencies = ['notification']

  override async boot(app: Application): Promise<void> {
    const manager = app.resolve(NotificationManager)
    manager.extend('discord', ({ instanceName, config }) => {
      const cfg = config as DiscordChannelConfig
      return new DiscordNotificationDriver({
        name: instanceName,
        ...(cfg.webhookUrl !== undefined ? { webhookUrl: cfg.webhookUrl } : {}),
        ...(cfg.username !== undefined ? { username: cfg.username } : {}),
        ...(cfg.avatarUrl !== undefined ? { avatarUrl: cfg.avatarUrl } : {}),
        ...(cfg.wait !== undefined ? { wait: cfg.wait } : {}),
        ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      })
    })
  }
}
