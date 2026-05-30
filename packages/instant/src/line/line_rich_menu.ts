/**
 * LINE rich-menu CRUD wrappers.
 *
 * Rich menus are persistent image-based menu bars at the bottom of
 * the LINE chat UI. Each menu is created with a JSON definition
 * (size, tappable areas, actions), then an image is uploaded for
 * it, and finally it's either set as the default menu or linked
 * to specific users.
 *
 * Wraps `@line/bot-sdk`'s `LineBotClient`. Apps that need narrower
 * surfaces (alias management, bulk linking) call into the client
 * directly via `driver.client`.
 */

import type { LineBotClient, messagingApi } from '@line/bot-sdk'
import { InstantProviderError } from '../errors.ts'

export class LineRichMenu {
  constructor(private readonly client: LineBotClient) {}

  create(input: messagingApi.RichMenuRequest): Promise<string> {
    return this.guard('richMenu.create', () =>
      this.client.createRichMenu(input).then((r) => r.richMenuId),
    )
  }

  delete(richMenuId: string): Promise<void> {
    return this.guard('richMenu.delete', () =>
      this.client.deleteRichMenu(richMenuId).then(() => undefined),
    )
  }

  setImage(richMenuId: string, image: Blob): Promise<void> {
    return this.guard('richMenu.setImage', () =>
      this.client.setRichMenuImage(richMenuId, image).then(() => undefined),
    )
  }

  setDefault(richMenuId: string): Promise<void> {
    return this.guard('richMenu.setDefault', () =>
      this.client.setDefaultRichMenu(richMenuId).then(() => undefined),
    )
  }

  linkToUser(userId: string, richMenuId: string): Promise<void> {
    return this.guard('richMenu.linkToUser', () =>
      this.client.linkRichMenuIdToUser(userId, richMenuId).then(() => undefined),
    )
  }

  unlinkFromUser(userId: string): Promise<void> {
    return this.guard('richMenu.unlinkFromUser', () =>
      this.client.unlinkRichMenuIdFromUser(userId).then(() => undefined),
    )
  }

  private async guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (cause) {
      throw new InstantProviderError(`LINE \`${operation}\` failed.`, {
        provider: 'line',
        operation,
        cause,
      })
    }
  }
}
