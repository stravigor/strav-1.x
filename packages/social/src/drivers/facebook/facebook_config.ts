/**
 * Facebook-specific provider config. Apps put one of these
 * inside `config.social.providers[name]` with `driver: 'facebook'`.
 *
 * Get credentials from https://developers.facebook.com → My
 * Apps → "Facebook Login" product → Settings. The `email` scope
 * needs Meta App Review approval before it works for users
 * outside the developer team — set up the review path before
 * going to production.
 */

import type { ProviderConfig } from '../../types.ts'

export interface FacebookProviderConfig extends ProviderConfig {
  driver: 'facebook'
  clientId: string
  clientSecret: string
  /**
   * Graph API version. Default `'v18.0'`. Apps that need
   * a specific feature pin it explicitly; otherwise the default
   * gets bumped at the next driver release.
   */
  graphVersion?: string
  /**
   * Profile field list — passed as `?fields=...` on `/me`.
   * Default covers `id,name,email,first_name,last_name,picture,locale`.
   * Apps that need extra fields (e.g. `birthday`, `gender`) override.
   */
  profileFields?: readonly string[]
  /** Override endpoints for testing — never set in production. */
  endpoints?: {
    authorize?: string
    token?: string
    me?: string
    permissions?: string
    debugToken?: string
  }
  fetch?: typeof fetch
}

const GRAPH = 'https://graph.facebook.com'
const DEFAULT_VERSION = 'v18.0'

export function facebookEndpoints(version = DEFAULT_VERSION): {
  authorize: string
  token: string
  me: string
  permissions: string
  debugToken: string
} {
  return {
    authorize: `https://www.facebook.com/${version}/dialog/oauth`,
    token: `${GRAPH}/${version}/oauth/access_token`,
    me: `${GRAPH}/${version}/me`,
    permissions: `${GRAPH}/${version}/me/permissions`,
    debugToken: `${GRAPH}/${version}/debug_token`,
  }
}

export const DEFAULT_FACEBOOK_PROFILE_FIELDS: readonly string[] = [
  'id',
  'name',
  'email',
  'first_name',
  'last_name',
  'picture.type(large)',
  'locale',
]
