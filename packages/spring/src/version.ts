/**
 * Framework version that scaffolded apps pin to in their generated
 * `package.json`. Bumped manually at release; see the template-strategy ADR.
 *
 * Spring's own `package.json` version tracks the workspace alpha for now,
 * but this constant is what *generated apps* depend on — keep them in sync
 * on each release until spring formally cuts independent versions.
 */
export const STRAV_VERSION = '^1.0.0-alpha.29'
