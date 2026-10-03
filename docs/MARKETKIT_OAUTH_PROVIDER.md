# MarketKit OAuth-provider extension — config & build packet

Owner artifact: `src/lib/marketkit-oauth-provider.ts`
Consumer boundary artifact: `marketkit-mcp-beta/mcp/oauth.ts` (RESOURCE SERVER, MCP OAuth 2.1)
Advisory gate: GHSA-p2fr-6hmx-4528 (needs `@better-auth/oauth-provider` >= 1.7.0)

## What this is (and is not)

`applyMarketKitOAuthExtension` composes a **REAL** `oauthProvider()` plugin from
`@better-auth/oauth-provider` — not a plain options object cast to a plugin. The
value appended to the plugin list is the object the provider runtime produced
(`id: "oauth-provider"`, carrying its own installed `version` and `schema`).

Because the module statically imports the provider package, it belongs to the
**OPTIONAL extension build only** (`Dockerfile.marketkit`). The shared public
auth-api service keeps `better-auth` 1.6.23, has no provider dependency, and
never enables the extension.

## Default OFF

The extension is inert unless `MARKETKIT_OAUTH_ENABLED=true`. When OFF the
existing `plugins` array (jwt RS256 + JWKS only) is returned by reference, so app
JWT/session/login/workload-DPoP consumers are unaffected. Verified in-image:
`applyMarketKitOAuthExtension(base, {}) === base`.

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
| `MARKETKIT_OAUTH_CONSENT_PAGE` | yes | site-relative path, e.g. `/consent` |
| `MARKETKIT_OAUTH_LOGIN_PAGE` | yes | site-relative path, e.g. `/login` |

Fail-closed: any partial/malformed config (missing id/resource/redirects/pages,
non-https, wildcard, fragment, absolute consent/login URL) throws at startup.

There is **no** env var for the provider version. The compatibility gate reads
the INSTALLED version from the live plugin object; an env-supplied value is never
trusted.

## PKCE — always

`clientRegistrationRequirePKCE: true` is unconditional. There is no env switch
to relax it, and the seeded `auth.oauthClients` row must carry
`requirePKCE = TRUE` (migration default). Verified end-to-end: an authorize
request without `code_challenge` is rejected with `error=invalid_request`.

## Version gate (GHSA-p2fr-6hmx-4528)

- Advisory floor `1.7.0`; pinned, end-to-end-verified floor `1.7.7`.
- Malformed versions (`1.7`, `v1.7.7`, `""`, `1.7.7-`, whitespace) are rejected
  — never coerced.
- Any prerelease (`1.7.0-beta.9`, `1.8.0-rc.1`) is rejected.
- The installed version is read from the plugin runtime, not from configuration.

## Matching the MCP resource-server contract (`mcp/oauth.ts`)

`mcp/oauth.ts` enforces STRICT issuer / audience / expiry / scope / resource
(RFC 8707) via `jose` + the MCP SDK, and requires `mcp:tools` (tool calls) and
`mcp:artifacts:read` (artifact fetch). The issued access token is bound to the
configured resource: verified by the isolated flow test, where
`aud = MARKETKIT_OAUTH_RESOURCE`, `iss = BETTER_AUTH_URL`, `scope` equals the
granted set, and `sub` is present.

## Schema

`migrations/changelog/changes/auth/007-create-oauth-provider-tables.sql` is
DERIVED from the INSTALLED `@better-auth/oauth-provider@1.7.7` metadata via
better-auth's own `getAuthTables()` + postgres type mapping (the same mapping
`get-migration` uses) — NOT from an assumed shape. Two properties are load-bearing
and were each verified by driving the real flow against an isolated PostgreSQL:

- **Table identifiers are the plugin's SINGULAR `modelName` values**, quoted:
  `auth."oauthClient"`, `auth."oauthResource"`, `auth."oauthClientResource"`,
  `auth."oauthRefreshToken"`, `auth."oauthAccessToken"`, `auth."oauthConsent"`,
  `auth."oauthClientAssertion"`. The runtime's `getModelName` uses `usePlural:
  false`, so a pluralised table (e.g. `oauthClients`) is NOT found and the server
  fails the schema check. An earlier hand-written placeholder (plural
  `oauth_clients`, `TEXT[]`) does not match and is intentionally NOT merged — see
  `changes/marketkit-oauth/README.md`.
- **`string[]` fields map to `JSONB` on postgres** (not `TEXT[]`). The adapter
  JSON-serialises array fields, so a `TEXT[]` column yields `malformed array
  literal` at write time.

`auth."oauthClient"."requirePKCE"` defaults `TRUE`. The migration is additive and
unused until the extension is ON.

## Applying the schema (opt-in, not automatic)

The changeSet is deliberately NOT in `db.changelog-master.yaml`, so the shared
service's default migrate step never creates authorization-server tables. It
lives in a separate changelog and is applied explicitly, only when enabling the
extension:

```sh
liquibase --changeLogFile=migrations/changelog/db.changelog-marketkit-oauth.yaml \
          --url="$DATABASE_URL" update
```


## Build / registry target

- Extension build context: `Dockerfile.marketkit` (pins better-auth 1.7.7 +
  `@better-auth/oauth-provider` 1.7.7).
- Base builds: `Dockerfile` / `Dockerfile.dev` (unchanged, base behaviour).
- Registry target: `marketkit/auth-api:<tag>`; this build's tag is
  `marketkit-oauth-provider-177-extension`. The shared/global auth-api image is
  NOT replaced.

## Upgrade gate

`applyMarketKitOAuthExtension(plugins, env)` builds the real plugin and calls
`assertProviderCompatible(plugin.version)`, which throws when the installed
provider is below `1.7.7`. This build pins the verified pair; a future bump must
re-run the isolated flow test.
