import { Model } from '@strav/database'
import { articleSchema } from '../database/schemas/article_schema.ts'

export class Article extends Model {
  static override readonly schema = articleSchema

  id!: string
  tenant_id!: string
  title!: string
  body!: string
  created_at!: Date
  updated_at!: Date
}
