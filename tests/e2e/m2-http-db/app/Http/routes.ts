import type { Router } from '@strav/http'
import { PostsController } from './Controllers/posts_controller.ts'

/** Wire the POST CRUD endpoints under the tenant-scoped middleware. */
export function registerRoutes(router: Router): void {
  router.group({ middleware: 'tenant' }, (r) => {
    r.get('/posts', [PostsController, 'index'])
    r.get('/posts/:id', [PostsController, 'show'])
    r.post('/posts', [PostsController, 'store'])
    r.delete('/posts/:id', [PostsController, 'destroy'])
  })
}
