import { Repository } from '@strav/database'
import { Post } from '../Models/post.ts'

export class PostRepository extends Repository<Post> {
  static override readonly schema = Post.schema
  static override readonly model = Post
}
