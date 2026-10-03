# MarketKit OAuth-provider extension — config & build packet

Owner artifact: `src/lib/marketkit-oauth-provider.ts`
Consumer boundary artifact: `marketkit-mcp-beta/mcp/oauth.ts` (RESOURCE SERVER, MCP OAuth 2.1)
Advisory gate: GHSA-p2fr-6hmx-4528 (needs `@better-auth/oauth-provider` >= 1.7.0)

## Default OFF

The extension is inert unless `MARKETKIT_OAUTH_ENABLED=true`. When OFF the
existing `plugins` array (jwt RS256 + JWKS only) is returned unchanged, so app
JWT/session/login/workload-DPoP consumers are byte-for-byte unaffected.

## Explicit env contract (all values explicit; no upstream defaults)

| Env var | Required when ON | Meaning |
| --- | --- | --- |
| `MARKETKIT_OAUTH_ENABLED` | yes (`"true"`) | master switch |
| `MARKETKIT_OAUTH_CLIENT_ID` | yes | OAuth client identity |
| `MARKETKIT_OAUTH_CLIENT_NAME` | yes | display name |
| `MARKETKIT_OAUTH_RESOURCE` | yes | RFC 8707 resource / audience (absolute https) |
| `MARKETKIT_OAUTH_REDIRECT_URIS` | yes | comma list, exact https, no wildcard/fragment |
| `MARKETKIT_OAUTH_ALLOWED_ORIGINS` | yes | comma list, absolute https |
| `MARKETKIT_OAUTH_SCOPES` | yes | e.g. `mcp:tools,mcp:artifacts:read` |
| `MARKETKIT_OAUTH_CLIENT_REGISTRATION_ALLOWED_RESOURCES` | no | defaults to `RESOURCE` |
| `MARKETKIT_OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES` | no | defaults to `SCOPES` |
| `MARKETKIT_OAUTH_REQUIRE_PKCE` | no | defaults `true` |
| `MARKETKIT_OAUTH_CONSENT_REQUIRED` | no | defaults `true` |
| `MARKETKIT_OAUTH_PROVIDER_VERSION` | no | installed provider version for the gate; defaults to floor |

Fail-closed: any partial/malformed config (missing id/resource/redirects,
non-https, wildcard, fragment) throws at startup.

## Matching the MCP resource-server contract (`mcp/oauth.ts`)

`mcp/oauth.ts` enforces STRICT issuer / audience / expiry / scope / resource
(RFC 8707) via `jose` + the MCP SDK, and requires `mcp:tools` (tool calls) and
`mcp:artifacts:read` (artifact fetch). The authorization server produced by this
extension MUST therefore:

- issue access tokens whose `iss` equals the configured Better Auth issuer,
  whose `aud` equals `MARKETKIT_OAUTH_RESOURCE`, and carry the granted `scope`;
- bind `sub` to the durable Better Auth user id (stable across sessions);
- expose a JWKS the resource server can fetch (Better Auth `jwt` plugin, RS256);
- narrow refresh so a refreshed token's audience/scope cannot exceed the
  original authorization (patched behavior, >= 1.7.0);
- reject cross-audience / unlisted redirect requests.

## Build / registry target

- Repo-local build context: this repository (`auth-api`), Dockerfile multi-stage.
- Registry target (per MarketKit integration request): `marketkit/auth-api`.
  Read-only convention in `flux-control-marketkit` currently shows
  `registry.sarvent.cloud/reduceops/auth-api` for the reduceops consumer; the
  MarketKit consumer entry is NOT yet present in that repo. Treat the final
  registry path as an integration gate to confirm with the parent.

## Upgrade gate

`applyMarketKitOAuthExtension(plugins, env, providerVersion)` calls
`assertProviderCompatible(providerVersion)`, which throws when the installed
provider is below `1.7.0`. The pinned shared identity currently depends on
`better-auth` 1.6.23 (core) and does NOT ship an `oauthProvider` export — a real
upgrade to a patched core/provider pair (peer `better-auth` ^1.7.7 for
`@better-auth/oauth-provider@1.7.7`) is a separate, parent-approved change.
