--liquibase formatted sql

--changeset auth-api:marketkit-ba-schema-align-177 context:development,production
--comment: Align the SHARED base auth tables with the better-auth 1.7.7 table metadata. better-auth 1.7.7's runtime schema check requires jwt-plugin columns (jwks.expiresAt / alg / crv) and the config-declared users.organizationId field; a fresh deployment that predates those columns serves /health 200 but returns SCHEMA_MISMATCH (500) from every Better Auth route, including OAuth discovery and the authorization server. Additive and idempotent: ADD COLUMN IF NOT EXISTS only, never a drop or type change. Verified against an isolated PostgreSQL  in scripts/verify-isolated-as-flow.sh.
--
-- Scope note: this changeSet is staged in its OWN opt-in changelog
-- (db.changelog-better-auth-schema-align.yaml) and is deliberately NOT referenced by
-- db.changelog-master.yaml, so applying the shared default migrate step is unchanged.
-- It is a prerequisite for a runnable DEDICATED Better Auth (or OAuth-provider)
-- deployment on an isolated database. See docs/BOOTHWRIGHT_AS_VERIFICATION.md.

-- better-auth 1.7.7 jwt plugin adds rotation metadata to the JWKS table.
ALTER TABLE auth.jwks ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ;
ALTER TABLE auth.jwks ADD COLUMN IF NOT EXISTS "alg" TEXT;
ALTER TABLE auth.jwks ADD COLUMN IF NOT EXISTS "crv" TEXT;

-- Declared in src/lib/auth.ts user.additionalFields; better-auth's schema check
-- verifies it before serving requests.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

--rollback ALTER TABLE auth.users DROP COLUMN IF EXISTS "organizationId"; ALTER TABLE auth.jwks DROP COLUMN IF EXISTS "crv"; ALTER TABLE auth.jwks DROP COLUMN IF EXISTS "alg"; ALTER TABLE auth.jwks DROP COLUMN IF EXISTS "expiresAt";
