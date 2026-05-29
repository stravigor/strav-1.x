/**
 * OAuth support for the local MCP client.
 *
 * Most real-world MCP servers (Linear, Notion, GitHub, Asana,
 * Atlassian) are OAuth-protected. The local client at
 * `@strav/brain/mcp` already supports static bearer tokens via
 * `MCPServer.authorizationToken` — fine for self-hosted servers,
 * useless against any commercial server. This module closes the
 * gap.
 *
 * The flow apps see:
 *
 * ```ts
 * const store = new MemoryOAuthStore()
 * const linear: MCPServer = {
 *   name: 'linear',
 *   url: 'https://mcp.linear.app',
 *   oauth: {
 *     redirectUri: 'https://myapp.com/mcp/linear/callback',
 *     scope: 'read',
 *     store,
 *   },
 * }
 *
 * try {
 *   const client = new MCPClient(linear)
 *   await client.connect()
 * } catch (err) {
 *   if (err instanceof MCPAuthRequiredError) {
 *     // Redirect the user to err.authorizationUrl and remember
 *     // who they were (so the callback handler can rebuild the
 *     // store with the right per-user state).
 *   }
 * }
 *
 * // Later, in the callback handler:
 * const client = new MCPClient(linear)
 * await client.completeAuthorization(req.query.code)
 * // The store now has tokens; subsequent connect()s succeed.
 * ```
 *
 * The framework is server-side and headless — it can't redirect
 * the user inline. So instead of blocking on `connect()`, we
 * surface `MCPAuthRequiredError` carrying the authorization URL.
 * Apps redirect the user themselves, then call
 * `MCPClient.completeAuthorization(code)` from their callback
 * route.
 *
 * Multi-tenancy: build a fresh `MCPOAuthStore` per `(user, server)`
 * with the user id baked into the storage keys. The store
 * interface is intentionally per-server (no `userId` arg) so apps
 * pick the boundary that matches their data model.
 */

import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { BrainError } from '../brain_error.ts'

/**
 * Persistence contract for one MCP server's OAuth state.
 *
 * Methods may be sync or async — implementations are free to call
 * a DB, a Redis cache, a file, or hold the state in memory. The
 * framework awaits whichever shape returns.
 *
 * Per-(server) only by design — apps that need per-(user, server)
 * scoping construct a fresh store per request with the user id
 * baked into the underlying storage keys.
 */
export interface MCPOAuthStore {
  /** Load the dynamic-client-registration record, or undefined if not registered. */
  clientInformation():
    | OAuthClientInformation
    | undefined
    | Promise<OAuthClientInformation | undefined>
  /** Persist the dynamic-client-registration record after registration succeeds. */
  saveClientInformation(info: OAuthClientInformationFull): void | Promise<void>
  /** Load the active token set, or undefined if the user hasn't authorized. */
  tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>
  /** Persist tokens after authorization completes or a refresh succeeds. */
  saveTokens(tokens: OAuthTokens): void | Promise<void>
  /** Load the PKCE code verifier saved during the authorize step. */
  codeVerifier(): string | Promise<string>
  /** Persist the PKCE code verifier before redirecting to authorize. */
  saveCodeVerifier(verifier: string): void | Promise<void>
}

/** Per-server OAuth configuration on `MCPServer.oauth`. */
export interface MCPOAuthConfig {
  /** Where the user comes back after authorizing. Must match a registered redirect URI on the OAuth server. */
  redirectUri: string
  /** Optional OAuth scopes to request. Some servers require specific scopes. */
  scope?: string
  /** Per-server token + client-info storage. */
  store: MCPOAuthStore
  /** Optional client metadata for dynamic client registration. Defaults to a minimal sane shape. */
  clientMetadata?: Partial<OAuthClientMetadata>
}

/**
 * `MemoryOAuthStore` — in-memory `MCPOAuthStore` implementation.
 *
 * Fine for tests and single-process dev. Production apps with
 * multiple processes or restarts persist to a DB / Redis / KV.
 */
export class MemoryOAuthStore implements MCPOAuthStore {
  private _clientInfo: OAuthClientInformationFull | undefined
  private _tokens: OAuthTokens | undefined
  private _verifier: string | undefined

  clientInformation(): OAuthClientInformation | undefined {
    return this._clientInfo
  }
  saveClientInformation(info: OAuthClientInformationFull): void {
    this._clientInfo = info
  }
  tokens(): OAuthTokens | undefined {
    return this._tokens
  }
  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens
  }
  codeVerifier(): string {
    if (this._verifier === undefined) {
      throw new BrainError(
        'MemoryOAuthStore.codeVerifier(): no PKCE verifier saved. The authorization flow must call saveCodeVerifier before requesting the verifier.',
      )
    }
    return this._verifier
  }
  saveCodeVerifier(verifier: string): void {
    this._verifier = verifier
  }
}

/**
 * Thrown when an MCP server requires the user to authorize before
 * the framework can connect. Apps catch this on `MCPClient.connect()`,
 * redirect the user to `authorizationUrl`, and on the OAuth callback
 * route call `MCPClient.completeAuthorization(code)` to finish the
 * flow.
 *
 * `BrainError` subclass so the typed-exception handler renders it
 * cleanly through the standard pathway.
 */
export class MCPAuthRequiredError extends BrainError {
  /** URL the user should be redirected to in order to authorize. */
  readonly authorizationUrl: string

  constructor(serverName: string, authorizationUrl: string) {
    super(
      `MCPClient(${serverName}): authorization required. Redirect the user to authorizationUrl and call completeAuthorization(code) from your callback route.`,
      {
        context: { server: serverName, authorizationUrl },
      },
    )
    this.authorizationUrl = authorizationUrl
  }
}

/**
 * Default client metadata used when dynamic client registration
 * fires. Apps override per-server via
 * `MCPOAuthConfig.clientMetadata`.
 */
function defaultClientMetadata(redirectUri: string): OAuthClientMetadata {
  return {
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'strav-brain',
  }
}

/**
 * Internal — implements the SDK's `OAuthClientProvider` against an
 * `MCPOAuthStore`. Holds the auth URL captured from the SDK so
 * `MCPClient.connect()` can surface it on `MCPAuthRequiredError`.
 */
export class StoreBackedOAuthProvider implements OAuthClientProvider {
  /** Captured auth URL — populated by the SDK when authorization is needed. */
  capturedAuthorizationUrl: URL | undefined

  constructor(
    private readonly config: MCPOAuthConfig,
  ) {}

  get redirectUrl(): string {
    return this.config.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      ...defaultClientMetadata(this.config.redirectUri),
      ...(this.config.scope !== undefined ? { scope: this.config.scope } : {}),
      ...(this.config.clientMetadata ?? {}),
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return await this.config.store.clientInformation()
  }
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.config.store.saveClientInformation(info)
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    return await this.config.store.tokens()
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.config.store.saveTokens(tokens)
  }
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.capturedAuthorizationUrl = authorizationUrl
  }
  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.config.store.saveCodeVerifier(verifier)
  }
  async codeVerifier(): Promise<string> {
    return await this.config.store.codeVerifier()
  }
}
