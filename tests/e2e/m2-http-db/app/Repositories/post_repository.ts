// biome-ignore lint/style/useImportType: PostgresDatabase needs to be a value import — the @inject() decorator below resolves the constructor param via reflect-metadata, which requires the runtime class reference.
import { PostgresDatabase, Repository } from '@strav/database'
// biome-ignore lint/style/useImportType: EventBus has the same constraint as PostgresDatabase — reflect-metadata needs the runtime class for @inject() param resolution.
import { EventBus, inject } from '@strav/kernel'
import { Post } from '../Models/post.ts'

@inject()
export class PostRepository extends Repository<Post> {
  static override readonly schema = Post.schema
  static override readonly model = Post

  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor forces TypeScript to emit `design:paramtypes` metadata on the subclass for the @inject() decorator above.
  constructor(db: PostgresDatabase, events: EventBus) {
    super(db, events)
  }
}
