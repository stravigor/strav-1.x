/**
 * Small utilities shared by `AnthropicBrainDriver`. Kept separate
 * from the message builder / response mapper because these are
 * content-agnostic — beta routing, abort-signal probing, text
 * collection, and beta-header merging.
 */

import type Anthropic from '@anthropic-ai/sdk'

/** Build the request-options bag forwarded to the SDK. Only `signal` for now. */
export function reqOpts(options: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  return options.signal !== undefined ? { signal: options.signal } : undefined
}

/** Throw a DOMException-shaped abort error if the signal has fired. */
export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

/**
 * Whether the request needs to flow through `client.beta.messages.create`
 * instead of the stable surface. Triggered by:
 *
 *   - `edits[]` (compaction).
 *   - `mcp_servers[]` (server-side MCP).
 *
 * Tests typically stub `client.messages.create`; the beta path uses the
 * stub that lives at `client.beta.messages.create`.
 */
export function needsBetaRouting(params: Anthropic.MessageCreateParamsNonStreaming): boolean {
  const p = params as { edits?: unknown[]; mcp_servers?: unknown[] }
  return (
    (p.edits !== undefined && p.edits.length > 0) ||
    (p.mcp_servers !== undefined && p.mcp_servers.length > 0)
  )
}

export function mergeBetas(
  providerBetas: readonly string[],
  callBetas: readonly string[] | undefined,
): readonly string[] {
  if (!callBetas || callBetas.length === 0) return providerBetas
  const seen = new Set<string>()
  const out: string[] = []
  for (const b of providerBetas) {
    if (seen.has(b)) continue
    seen.add(b)
    out.push(b)
  }
  for (const b of callBetas) {
    if (seen.has(b)) continue
    seen.add(b)
    out.push(b)
  }
  return out
}

export function collectText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
