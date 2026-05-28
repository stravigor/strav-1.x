import { Model } from '@strav/database'
import { postSchema } from '../../database/schemas/post_schema.ts'

export class Post extends Model {
  static override readonly schema = postSchema
  id!: string
  tenant_id!: string
  title!: string
  body!: string
  created_at!: Date
  updated_at!: Date
}
