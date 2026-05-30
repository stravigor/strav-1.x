# LINE — rich menus

Rich menus are persistent, image-based menu bars at the bottom of a LINE chat. They have tappable regions tied to actions (open URL, send postback, datetime picker). A menu can be set as the default for all users, or linked per user.

## Create a menu

```ts
import { InstantManager } from '@strav/instant'

const instant = app.resolve(InstantManager)
const richMenu = instant.use('line').richMenu

const richMenuId = await richMenu.create({
  size: { width: 2500, height: 843 },
  selected: true,
  name: 'main-menu',
  chatBarText: 'Menu',
  areas: [
    {
      bounds: { x: 0,    y: 0, width: 1250, height: 843 },
      action: { type: 'postback', data: 'menu=order' },
    },
    {
      bounds: { x: 1250, y: 0, width: 1250, height: 843 },
      action: { type: 'uri', uri: 'https://example.com/help' },
    },
  ],
})
```

## Upload the image

```ts
const image = await Bun.file('./rich-menu.png').arrayBuffer()
await richMenu.setImage(richMenuId, new Blob([image], { type: 'image/png' }))
```

Image must be PNG or JPEG, exactly the size declared in `size`, ≤ 1 MB.

## Set as default

```ts
await richMenu.setDefault(richMenuId)
```

All followers (existing and new) now see this menu unless they have a per-user override.

## Per-user assignment

```ts
await richMenu.linkToUser(userId, richMenuId)
// later:
await richMenu.unlinkFromUser(userId)
```

Useful for VIP customers, logged-in users, members in a specific segment, etc.

## Cleanup

```ts
await richMenu.delete(richMenuId)
```

Doesn't unlink existing per-user assignments first — call `unlinkFromUser` for those users before deleting if you care about the cleanup.
