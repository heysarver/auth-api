# Boothwright dedicated authorization server — isolated verification packet

Source pin reviewed: `26f4b19539b189015396343b6fd539318b29a3de`
(`feat/marketkit-oauth-extension-real`, repo `heysarver/auth-api`).
Verification worktree/branch: `feat/boothwright-oauth-as-verify` (this branch).
Pinned pair: `better-auth@1.7.7` + `@better-auth/oauth-provider@1.7.7`.

This packet verifies the **dedicated, separately-built** authorization server
(`Dockerfile.marketkit`, registry target `marketkit/auth-api:<tag>`). It does **not**
touch the shared public identity service (`Dockerfile` / `Dockerfile.dev`), the
private existing workbench, or the global auth-api. No live database migration,
no Google client change, no live users, no purchases.

## What was exercised (all reproducible via `scripts/verify-isolated-as-flow.sh`)

`bash scripts/verify-isolated-as-flow.sh` stands up throwaway PostgreSQL 16 +
Redis containers, applies the schema, builds the extension image, boots it with
`MARKETKIT_OAUTH_ENABLED=true`, and asserts:

| Check | Result | Evidence |
| --- | --- | --- |
| TS build (`tsc`) | pass | build log |
| Full test suite | 387 passed / 30 files | `evidence/vitest-full.log` |
| ESLint | 0 errors (107 pre-existing warnings) | lint log |
| Extension image build (`Dockerfile.marketkit`) | pass | `evidence/docker-build-marketkit.log` |
| Migration 007 applies to real PostgreSQL | 7 oauth* tables created | `scripts/verify-isolated-as-flow.sh` step 2 |
| `/health` on booted container | `200 healthy`, `database:true` | script step 5 |
| OAuth 2.1 discovery document | served at `/.well-known/oauth-authorization-server` | script step 5 |
| Full live flow over HTTP (sign-up → authorize/S256 → token → **JWKS-verified** identity) | pass | `evidence/live-container-flow.log` |
| Isolated PostgreSQL flow (sign-up → authorize → token → JWKS verify → refresh replay) | pass | `evidence/pg-flow.log` |
| Discovery probe (issuer / endpoints / S256) | pass | `evidence/discovery-probe.log` |

Every identity assertion **verifies the RS256 signature against the live `/jwks`**
with real `jose` before checking claim equality — no unverified decoding. The
verified claims: `iss == BETTER_AUTH_URL`, `aud == MARKETKIT_OAUTH_RESOURCE`,
`client_id`, `sub == the actual signed-up user id`, `exp`, and the granted `scope`
set. Discovery proves the server advertises `code_challenge_methods_supported:
["S256"]` and `resource`/RFC 8707 support.

## Findings

**AS-VER-1 — provider advisory, patched.** `GHSA-p2fr-6hmx-4528`
("@better-auth/oauth-provider may provide access tokens for unauthorized audiences
via unbound resource indicators", severity **medium**, vuln range
`>=1.4.8 <1.7.0-beta.4`). The pin `1.7.7` is above the patched range; the extension's
`assertProviderCompatible()` gate reads the **installed** `plugin.version` (never env)
and rejects malformed/prerelease/sub-floor values, and fails closed at startup.
Advisory verified via the GitHub Advisory API (fetched during this run).

**AS-VER-2 — schema shape confirmed against the real installed plugin.** The
provider's own `plugin.schema` reports model keys
`oauthClient, oauthResource, oauthClientResource, oauthRefreshToken,
oauthAccessToken, oauthConsent, oauthClientAssertion`, all `string[]`/`json` fields
mapped to **JSONB**, and `requirePKCE` defaulting true. Migration 007's
singular-quoted table names + JSONB columns match exactly. The live PostgreSQL flow
confirms the runtime resolves them (the provider *auto-seeds* `oauthResource` from
config at boot — only possible with the correct singular/JSONB shape) and persists
JSONB array columns without a `malformed array literal` error.

**AS-VER-3 — base shared schema lags better-auth 1.7.7 (prerequisite for a fresh
deployment).** A fresh database built from the shared base migrations (`001`–`003`)
serves `/health` 200 but returns `SCHEMA_MISMATCH` (HTTP 500) from **every** Better
Auth route, including OAuth discovery and the authorization server, because
better-auth 1.7.7's runtime schema check requires:
- `auth.jwks."expiresAt" / "alg" / "crv"` (jwt-plugin rotation metadata), and
- `auth.users."organizationId"` (declared in `src/lib/auth.ts` `user.additionalFields`).

`migrations/changelog/changes/auth/002-create-jwks-table.sql` lacks the three jwks
columns; there is no migration creating `users."organizationId"`. This packet adds
`008-align-better-auth-177-schema.sql` (additive `ADD COLUMN IF NOT EXISTS` only) in
its **own opt-in changelog** (`db.changelog-better-auth-schema-align.yaml`), **not**
referenced by `db.changelog-master.yaml`, so the shared default migrate step is
unchanged. This is a **proposed** repair for review — it is not applied to any live
database here.

**AS-VER-4 — production dependency advisories (unresolved, out of this scope).**
`npm audit --omit=dev` on the pinned tree reports **22 vulnerabilities
(1 low, 13 moderate, 7 high, 1 critical)**. Neither `better-auth` nor
`@better-auth/oauth-provider` is flagged. Highest-signal: `proxy-addr` (critical,
IP-spoofing), and high-severity `axios`, `ip-address`, `nodemailer`, `brace-expansion`,
`nanoid`, `@grpc/grpc-js`. Full machine-readable output:
`evidence/npm-audit-prod.json`. These overlap the repo's existing Dependabot PRs and
were **not** changed here — repairing them is a separate, reviewable decision.

## External requirements for full production submission (human-only)

These are exact blockers that require a human identity or credential and are **not**
performed by this packet:

1. **Google OAuth client** for the dedicated authorization server: a real
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and the registered redirect URI
   (`resolveGoogleRedirectURI()` in `src/lib/oauth-config.ts`). No live Google
   credential is used or invented here.
2. **A real ChatGPT/MCP connector connection** to the deployed domain for the
   submission recording, endpoint/domain verification, and metadata/privacy/support
   pages that the current first-party submission flow requires. A local flow pass does
   not substitute for a real connector connection or approval.
3. **Production deploy authority** — image publication to
   `marketkit/auth-api:<tag>`, GitOps image-pointer change, and applying the opt-in
   migrations to the live authorization database.

## Scope boundaries held

- Private workbench, global auth-api, `Dockerfile` / `Dockerfile.dev`: **unchanged**.
- `db.changelog-master.yaml`: **unchanged** (the 007 and 008 changesets remain opt-in).
- Boothwright main integration worktree: **not** touched (another worker owns it).
- No live database migration, no image publication, no deployment, no merge.
- No secrets, tokens, or private keys are stored in any artifact; all fixture values
  are throwaway (`verify-secret-…`, `postgres:verify`, in-memory/isolated DBs).

## Files in this packet

- `migrations/changelog/changes/auth/008-align-better-auth-177-schema.sql` — proposed base-schema alignment (opt-in).
- `migrations/changelog/db.changelog-better-auth-schema-align.yaml` — opt-in changelog for 008.
- `scripts/verify-isolated-as-flow.sh` — one-shot isolated end-to-end reproduction.
- `live-container-flow.mjs` — live HTTP signed-token flow against the built image.
- `pg-flow.mjs` — real-PostgreSQL flow (singular/JSONB proof + refresh replay).
- `discovery-probe.mjs` — OAuth 2.1 discovery metadata assertions.
- `derive-schema.mjs`, `derive-jwks.mjs` — schema derivation from the installed plugin.
- `evidence/` — raw logs for every check above.
