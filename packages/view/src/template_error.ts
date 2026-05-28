/**
 * `TemplateError` — typed error raised at tokenize / compile / render
 * time for `.strav` templates.
 *
 *   - **Tokenize/compile**: unclosed directives, unknown directives,
 *     unbalanced blocks. `context.template` + `context.line` point at
 *     the source location.
 *   - **Render**: include depth exceeded, missing template file,
 *     thrown expressions inside `{{ }}`. `cause` carries the original
 *     throwable when applicable.
 *
 * `status` is fixed at 500 — template failures are bugs in the app's
 * own source. Surface a generic 500 page upstream; the developer sees
 * the full error in logs.
 */

import { StravError, type StravErrorOptions } from '@strav/kernel'

export class TemplateError extends StravError {
  constructor(message: string, options: StravErrorOptions = {}) {
    super(message, { code: 'template-error', status: 500 }, options)
  }
}
