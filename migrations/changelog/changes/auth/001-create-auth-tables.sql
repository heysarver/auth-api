--liquibase formatted sql

--changeset auth-api:002-create-auth-tables
--comment: Create better-auth tables in auth schema (managed by better-auth, structure for reference)

-- Note: These tables are typically auto-created by better-auth on first run
-- This migration ensures they exist with the correct structure
-- Column names use camelCase per better-auth conventions

-- Users table (plural per better-auth conventions)
CREATE TABLE IF NOT EXISTS auth.users (
    id VARCHAR(36) PRIMARY KEY,
    name TEXT NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    "emailVerified" BOOLEAN DEFAULT false NOT NULL,
    image TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Sessions table
CREATE TABLE IF NOT EXISTS auth.sessions (
    id VARCHAR(36) PRIMARY KEY,
    "userId" VARCHAR(36) NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Accounts table (for OAuth providers and credentials)
CREATE TABLE IF NOT EXISTS auth.accounts (
    id VARCHAR(36) PRIMARY KEY,
    "userId" VARCHAR(36) NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    scope TEXT,
    password TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Verifications table (for email verification and password reset)
CREATE TABLE IF NOT EXISTS auth.verifications (
    id VARCHAR(36) PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Create indexes for better-auth tables
CREATE INDEX IF NOT EXISTS idx_users_email ON auth.users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON auth.sessions(token);
CREATE INDEX IF NOT EXISTS "idx_sessions_userId" ON auth.sessions("userId");
CREATE INDEX IF NOT EXISTS "idx_sessions_expiresAt" ON auth.sessions("expiresAt");
CREATE INDEX IF NOT EXISTS "idx_accounts_userId" ON auth.accounts("userId");
CREATE INDEX IF NOT EXISTS "idx_accounts_providerId_accountId" ON auth.accounts("providerId", "accountId");
CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON auth.verifications(identifier);
CREATE INDEX IF NOT EXISTS "idx_verifications_expiresAt" ON auth.verifications("expiresAt");

--rollback DROP TABLE IF EXISTS auth.verifications CASCADE;
--rollback DROP TABLE IF EXISTS auth.accounts CASCADE;
--rollback DROP TABLE IF EXISTS auth.sessions CASCADE;
--rollback DROP TABLE IF EXISTS auth.users CASCADE;