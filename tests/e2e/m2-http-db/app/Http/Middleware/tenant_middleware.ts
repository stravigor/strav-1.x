/**
 * Reads the `X-Tenant-ID` header and runs the rest of the request inside
 * `TenantManager.withTenant(id, ...)` so RLS policies + ALS-routed
 * Repository calls all see the right tenant. Missing header → 400.
 *
 * This middleware is a fixture for the M2 e2e — real apps typically
 * derive the tenant from the authenticated session, a subdomain, or a
 * JWT claim. The wiring shape is identical; only the source differs.
 */

// biome-ignore lint/style/useImportType: TenantManager must be a value import — @inject() reads the constructor paramtype via reflect-metadata, which needs the runtime class reference.
import { TenantManager } from '@strav/database'
import type { HttpContext, NextFn } from '@strav/http'
import { inject } from '@strav/kernel'

@inject()
export class TenantMiddleware {
  constructor(private readonly tenants: TenantManager) {}

  async handle(ctx: HttpContext, next: NextFn): Promise<Response> {
    const tenantId = ctx.request.headers.get('x-tenant-id')
    if (!tenantId) {
      return ctx.response.json(
        { error: { code: 'tenant.missing', message: '`X-Tenant-ID` header is required.' } },
        { status: 400 },
      )
    }
    return this.tenants.withTenant(tenantId, async () => next())
  }
}
