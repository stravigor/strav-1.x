import type { HttpContext } from '@strav/http'
import { inject, ulid } from '@strav/kernel'
// biome-ignore lint/style/useImportType: PostRepository must be a value import — @inject() reads the constructor paramtype via reflect-metadata, which needs the runtime class reference.
import { PostRepository } from '../../Repositories/post_repository.ts'
import { CreatePostRequest } from '../Requests/create_post_request.ts'

@inject()
export class PostsController {
  constructor(private readonly posts: PostRepository) {}

  /** `GET /posts` — list this tenant's posts. RLS filters at the DB layer. */
  async index(ctx: HttpContext): Promise<Response> {
    const rows = await this.posts.query().orderBy('created_at', 'desc').get()
    return ctx.response.ok({ data: rows })
  }

  /** `GET /posts/:id` — single post; 404 when invisible or absent. */
  async show(ctx: HttpContext): Promise<Response> {
    const id = ctx.request.params.id
    if (!id) return ctx.response.json({ error: { code: 'post.missing-id' } }, { status: 400 })
    const post = await this.posts.find(id)
    if (post === null) {
      return ctx.response.json(
        { error: { code: 'post.not-found', message: `No post "${id}".` } },
        { status: 404 },
      )
    }
    return ctx.response.ok(post)
  }

  /**
   * `POST /posts` — validated via {@link CreatePostRequest}. The tenant
   * middleware has already bound `app.tenant_id` on the transaction so
   * the FK column is set inside the SQL emitter without the controller
   * needing to know which tenant is active.
   */
  async store(ctx: HttpContext): Promise<Response> {
    const req = await CreatePostRequest.from(ctx)
    const tenantId = ctx.request.headers.get('x-tenant-id') ?? ''
    const post = await this.posts.create({
      id: ulid(),
      tenant_id: tenantId,
      ...req.validated(),
    } as never)
    return ctx.response.created(post)
  }

  /** `DELETE /posts/:id` — hard delete (no soft-delete column on this schema). */
  async destroy(ctx: HttpContext): Promise<Response> {
    const id = ctx.request.params.id
    if (!id) return ctx.response.json({ error: { code: 'post.missing-id' } }, { status: 400 })
    const post = await this.posts.find(id)
    if (post === null) {
      return ctx.response.json({ error: { code: 'post.not-found' } }, { status: 404 })
    }
    await this.posts.delete(post)
    return ctx.response.noContent()
  }
}
