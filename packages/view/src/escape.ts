/**
 * HTML entity escape — the implementation behind every `{{ expr }}`
 * interpolation. The compiled render function wraps escaped output
 * with this; users can also call it explicitly via `@escape(value)`.
 *
 * Encodes the five XML/HTML-significant characters. Non-string values
 * are coerced via `String()` before encoding — `null` / `undefined`
 * render as the empty string (vs. literal `"null"` / `"undefined"`,
 * which would surprise users).
 *
 * Performance: a single-pass replacement via a regex with a lookup
 * map; faster than five sequential `.replace()` calls on hot paths.
 */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

const ENTITY_RE = /[&<>"']/g

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = typeof value === 'string' ? value : String(value)
  return str.replace(ENTITY_RE, (ch) => ENTITIES[ch] as string)
}
