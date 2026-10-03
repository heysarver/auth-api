--liquibase formatted sql

--changeset auth-api:marketkit-oauth-provider-177 context:development,production
--comment: OPT-IN MarketKit OAuth-provider schema generated from the INSTALLED @better-auth/oauth-provider@1.7.7 plugin schema (plugin.schema). Additive only: creates new oauth* tables, never alters existing auth tables. Unused until MARKETKIT_OAUTH_ENABLED=true. PKCE: auth.oauthClients.requirePKCE defaults TRUE.

-- oauthClient
CREATE TABLE IF NOT EXISTS auth.oauthClients (
    "id" TEXT PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "clientDiscoveryId" TEXT,
    "disabled" BOOLEAN,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" TEXT[],
    "clientCredentialsScopes" TEXT[],
    "userId" TEXT REFERENCES auth.users("id"),
    "createdAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ,
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" TEXT[] NOT NULL,
    "postLogoutRedirectUris" TEXT[],
    "backchannelLogoutUri" TEXT,
    "backchannelLogoutSessionRequired" BOOLEAN,
    "tokenEndpointAuthMethod" TEXT,
    "applicationType" TEXT,
    "jwks" TEXT,
    "jwksUri" TEXT,
    "grantTypes" TEXT[],
    "responseTypes" TEXT[],
    "requirePKCE" BOOLEAN NOT NULL DEFAULT TRUE,
    "dpopBoundAccessTokens" BOOLEAN,
    "referenceId" TEXT,
    "metadata" JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS oauthClients_clientId_idx
    ON auth.oauthClients ("clientId");

-- oauthResource
CREATE TABLE IF NOT EXISTS auth.oauthResources (
    "id" TEXT PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenTtl" INTEGER,
    "refreshTokenTtl" INTEGER,
    "signingAlgorithm" TEXT,
    "signingKeyId" TEXT,
    "allowedScopes" TEXT[],
    "customClaims" JSONB,
    "dpopBoundAccessTokensRequired" BOOLEAN,
    "disabled" BOOLEAN,
    "createdAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ,
    "policyVersion" INTEGER,
    "metadata" JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS oauthResources_identifier_idx
    ON auth.oauthResources ("identifier");

-- oauthClientResource
CREATE TABLE IF NOT EXISTS auth.oauthClientResources (
    "id" TEXT PRIMARY KEY,
    "clientId" TEXT NOT NULL REFERENCES auth.oauthClients("clientId") ON DELETE CASCADE,
    "resourceId" TEXT NOT NULL REFERENCES auth.oauthResources("identifier") ON DELETE CASCADE,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS oauthClientResources_clientId_resourceId_idx
    ON auth.oauthClientResources ("clientId", "resourceId");

-- oauthRefreshToken
CREATE TABLE IF NOT EXISTS auth.oauthRefreshTokens (
    "id" TEXT PRIMARY KEY,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL REFERENCES auth.oauthClients("clientId"),
    "sessionId" TEXT REFERENCES auth.sessions("id") ON DELETE SET NULL,
    "userId" TEXT NOT NULL REFERENCES auth.users("id"),
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "expiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ,
    "revoked" TIMESTAMPTZ,
    "rotatedAt" TIMESTAMPTZ,
    "rotationReplayResponse" TEXT,
    "rotationReplayExpiresAt" TIMESTAMPTZ,
    "authTime" TIMESTAMPTZ,
    "confirmation" JSONB,
    "scopes" TEXT[] NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS oauthRefreshTokens_token_idx
    ON auth.oauthRefreshTokens ("token");

-- oauthAccessToken
CREATE TABLE IF NOT EXISTS auth.oauthAccessTokens (
    "id" TEXT PRIMARY KEY,
    "token" TEXT,
    "clientId" TEXT NOT NULL REFERENCES auth.oauthClients("clientId"),
    "sessionId" TEXT REFERENCES auth.sessions("id") ON DELETE SET NULL,
    "userId" TEXT REFERENCES auth.users("id"),
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "refreshId" TEXT REFERENCES auth.oauthRefreshTokens("id"),
    "expiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ,
    "revoked" TIMESTAMPTZ,
    "confirmation" JSONB,
    "scopes" TEXT[] NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS oauthAccessTokens_token_idx
    ON auth.oauthAccessTokens ("token");

-- oauthConsent
CREATE TABLE IF NOT EXISTS auth.oauthConsents (
    "id" TEXT PRIMARY KEY,
    "clientId" TEXT NOT NULL REFERENCES auth.oauthClients("clientId"),
    "userId" TEXT REFERENCES auth.users("id"),
    "referenceId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "scopes" TEXT[] NOT NULL,
    "createdAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ
);

-- oauthClientAssertion
CREATE TABLE IF NOT EXISTS auth.oauthClientAssertions (
    "id" TEXT PRIMARY KEY,
    "expiresAt" TIMESTAMPTZ NOT NULL
);

--rollback DROP TABLE IF EXISTS auth.oauthClientAssertions; DROP TABLE IF EXISTS auth.oauthConsents; DROP TABLE IF EXISTS auth.oauthAccessTokens; DROP TABLE IF EXISTS auth.oauthRefreshTokens; DROP TABLE IF EXISTS auth.oauthClientResources; DROP TABLE IF EXISTS auth.oauthResources; DROP TABLE IF EXISTS auth.oauthClients;
