--liquibase formatted sql

--changeset auth-api:006-add-better-auth-1-7-schema-columns context:development,production
--comment: Add columns better-auth writes but no earlier changeset created

-- Better Auth compares the tables it writes against the live schema and, from
-- 1.7, does so by default and fails the request when a column is missing.
-- These four columns are absent from every environment. Two of them
-- (jwks.expiresAt, users.organizationId) are already expected by the version we
-- run today and are silently tolerated because 1.6 does not validate.
--
-- All four are nullable and nothing on 1.6.23 writes them, so this changeset is
-- safe to apply before the dependency upgrade and must be applied before it.

ALTER TABLE auth.jwks
    ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "alg" VARCHAR(32),
    ADD COLUMN IF NOT EXISTS "crv" VARCHAR(32);

ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS "organizationId" VARCHAR(255);

--rollback ALTER TABLE auth.users DROP COLUMN IF EXISTS "organizationId";
--rollback ALTER TABLE auth.jwks DROP COLUMN IF EXISTS "crv";
--rollback ALTER TABLE auth.jwks DROP COLUMN IF EXISTS "alg";
--rollback ALTER TABLE auth.jwks DROP COLUMN IF EXISTS "expiresAt";
