/**
 * `PaymentProduct` — normalized product (catalogue entry) record.
 * Prices attach to products and carry the actual billing terms.
 */

export interface PaymentProduct {
  id: string
  provider: string
  name: string
  description?: string
  active: boolean
  metadata: Record<string, string>
  createdAt: Date
  raw: unknown
}

export interface CreateProductInput {
  name: string
  description?: string
  active?: boolean
  metadata?: Record<string, string>
}

export interface UpdateProductInput {
  name?: string
  description?: string
  active?: boolean
  metadata?: Record<string, string>
}

export interface ListProductsOptions {
  cursor?: string
  limit?: number
  active?: boolean
}

export interface PaginatedProducts {
  data: PaymentProduct[]
  nextCursor: string | null
}
