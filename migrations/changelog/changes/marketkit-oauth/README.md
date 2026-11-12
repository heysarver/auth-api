# OPT-IN MarketKit OAuth-provider schema

This directory holds a **separate** Liquibase changelog for the opt-in MarketKit
OAuth-provider tables. It is intentionally **not** referenced by the shared
service's default `db.changelog-master.yaml`, so the default `migrate` step never
creates authorization-server tables. It is applied explicitly, only when the
extension is enabled.

## Why it is separate

The shared public `auth-api` identity service stays on its pinned
`better-auth@1.6.23` with **no** `@better-auth/oauth-provider` dependency and
never enables the extension. Auto-including the provider's schema in the default
changelog would run a live authorization-server migration as a side effect of an
unrelated deploy. Keeping it in its own changelog makes enablement an explicit,
reviewable step.

Apply it with:

```sh
liquibase \
  --changeLogFile=migrations/changelog/db.changelog-marketkit-oauth.yaml \
  --url="$DATABASE_URL" update
```

## What it creates

`changes/auth/007-create-oauth-provider-tables.sql` creates exactly the tables
the installed `@better-auth/oauth-provider@1.7.7` runtime resolves, derived from
the plugin's own metadata (see the doc `Schema` section). Table identifiers are
the plugin's **singular** `modelName` values — `oauthClient`, `oauthResource`,
`oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`,
`oauthClientAssertion` — quoted, and `string[]` fields are `JSONB` on postgres
(never `TEXT[]`). `auth."oauthClient"."requirePKCE"` defaults `TRUE` (PKCE is
mandatory). All statements are additive and `IF NOT EXISTS`; nothing existing is
altered or dropped. The tables are unused until `MARKETKIT_OAUTH_ENABLED=true`.

## Reconciliation with the earlier placeholder migration

An earlier, unmerged branch
(`feat/marketkit-oauth-provider-extension`, head `93744e4`) carries a
hand-written `006-create-oauth-provider-tables.sql` that creates **plural**
`auth.oauth_clients` (and `oauth_resources`, …) with `TEXT[]` array columns and a
`clientId` primary key. That placeholder does **not** match the installed 1.7.7
runtime (which resolves singular quoted table names and `JSONB` arrays), so it is
**not** merged. This directory supersedes it: `007` is generated from the real
plugin metadata and verified against an isolated PostgreSQL by driving the real
authorize→token→JWKS-verify flow. The parent branch is left untouched.
