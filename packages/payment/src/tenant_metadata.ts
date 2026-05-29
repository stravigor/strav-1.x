/**
 * Conventional metadata key that carries the Strav tenant id on
 * every create-call that should produce tenant-scoped webhooks.
 *
 * Multi-tenant apps stamp this on every `payment.customers.create`,
 * `payment.charges.create`, `payment.subscriptions.create`, etc.
 * Providers echo metadata back on every webhook delivery, so the
 * framework's `paymentWebhook()` dispatcher reads it back and
 * wraps ledger writes + user handlers in
 * `TenantManager.withTenant(...)`.
 *
 * Why a framework-namespaced key (not just `tenant_id`): some
 * apps use generic `tenant_id` for their own purposes (Stripe
 * Connect tenancy, partner account routing, …). `strav_tenant_id`
 * is reserved.
 *
 * Key length: provider metadata limits — Stripe ≤ 40 chars, Omise
 * keys ≤ 255 chars. Our prefix `strav_tenant_id` is 15 chars, well
 * within both. Values are app-supplied tenant ids (typically
 * ULIDs = 26 chars).
 */

export const TENANT_METADATA_KEY = 'strav_tenant_id'

/**
 * Build a metadata bag that stamps the tenant id alongside
 * any caller-supplied keys. Use on every create call that should
 * produce tenant-scoped webhook events.
 *
 * ```ts
 * await payment.customers.create({
 *   email: user.email,
 *   metadata: tenantedMetadata(user.tenant_id, { source: 'signup' }),
 * })
 * ```
 *
 * If `extra` already contains `strav_tenant_id`, the explicit
 * argument wins — apps that want to override (rare; testing
 * fixtures) can do so.
 */
export function tenantedMetadata(
  tenantId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...extra, [TENANT_METADATA_KEY]: tenantId }
}

/**
 * Extract a Strav tenant id from a provider's metadata bag. Used
 * by driver `normalize` functions when reading webhook events.
 * Returns `undefined` when the metadata is missing or the tenant
 * key isn't set.
 */
export function readTenantId(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!metadata) return undefined
  const v = metadata[TENANT_METADATA_KEY]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
