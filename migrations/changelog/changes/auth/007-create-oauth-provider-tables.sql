--liquibase formatted sql

--changeset auth-api:marketkit-oauth-provider-177 context:development,production
--comment: OPT-IN MarketKit OAuth-provider schema, DERIVED from the INSTALLED @better-auth/oauth-provider@1.7.7 plugin schema via better-auth's own getAuthTables() + get-migration postgres type mapping. Identifiers match exactly what the 1.7.7 runtime resolves: the plugin modelName values are SINGULAR (oauthClient, oauthResource, oauthClientResource, oauthRefreshToken, oauthAccessToken, oauthConsent, oauthClientAssertion) and `string[]` fields map to JSONB on postgres, NOT TEXT[]. See docs/MARKETKIT_OAUTH_PROVIDER.md section Schema for generation + verification. Additive only: creates new oauth* tables, never alters existing auth tables. Unused until MARKETKIT_OAUTH_ENABLED=true. PKCE: auth."oauthClient"."requirePKCE" defaults TRUE.


CREATE TABLE IF NOT EXISTS auth."oauthClient" (
  "id" TEXT PRIMARY KEY,
  "clientId" TEXT NOT NULL UNIQUE,
  "clientSecret" TEXT,
  "clientDiscoveryId" TEXT,
  "disabled" BOOLEAN,
  "skipConsent" BOOLEAN,
  "enableEndSession" BOOLEAN,
  "subjectType" TEXT,
  "scopes" JSONB,
  "clientCredentialsScopes" JSONB,
  "userId" TEXT REFERENCES auth."users"("id"),
  "createdAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ,
  "name" TEXT,
  "uri" TEXT,
  "icon" TEXT,
  "contacts" JSONB,
  "tos" TEXT,
  "policy" TEXT,
  "softwareId" TEXT,
  "softwareVersion" TEXT,
  "softwareStatement" TEXT,
  "redirectUris" JSONB NOT NULL,
  "postLogoutRedirectUris" JSONB,
  "backchannelLogoutUri" TEXT,
  "backchannelLogoutSessionRequired" BOOLEAN,
  "tokenEndpointAuthMethod" TEXT,
  "applicationType" TEXT,
  "jwks" TEXT,
  "jwksUri" TEXT,
  "grantTypes" JSONB,
  "responseTypes" JSONB,
  "requirePKCE" BOOLEAN DEFAULT TRUE,
  "dpopBoundAccessTokens" BOOLEAN,
  "referenceId" TEXT,
  "metadata" JSONB
);

CREATE TABLE IF NOT EXISTS auth."oauthResource" (
  "id" TEXT PRIMARY KEY,
  "identifier" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "accessTokenTtl" INTEGER,
  "refreshTokenTtl" INTEGER,
  "signingAlgorithm" TEXT,
  "signingKeyId" TEXT,
  "allowedScopes" JSONB,
  "customClaims" JSONB,
  "dpopBoundAccessTokensRequired" BOOLEAN,
  "disabled" BOOLEAN,
  "createdAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ,
  "policyVersion" INTEGER,
  "metadata" JSONB
);

CREATE TABLE IF NOT EXISTS auth."oauthClientResource" (
  "id" TEXT PRIMARY KEY,
  "clientId" TEXT NOT NULL REFERENCES auth."oauthClient"("clientId"),
  "resourceId" TEXT NOT NULL REFERENCES auth."oauthResource"("identifier"),
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth."oauthRefreshToken" (
  "id" TEXT PRIMARY KEY,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES auth."oauthClient"("clientId"),
  "sessionId" TEXT REFERENCES auth."sessions"("id"),
  "userId" TEXT NOT NULL REFERENCES auth."users"("id"),
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" JSONB,
  "requestedUserInfoClaims" JSONB,
  "expiresAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ,
  "revoked" TIMESTAMPTZ,
  "rotatedAt" TIMESTAMPTZ,
  "rotationReplayResponse" TEXT,
  "rotationReplayExpiresAt" TIMESTAMPTZ,
  "authTime" TIMESTAMPTZ,
  "confirmation" JSONB,
  "scopes" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS auth."oauthAccessToken" (
  "id" TEXT PRIMARY KEY,
  "token" TEXT UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES auth."oauthClient"("clientId"),
  "sessionId" TEXT REFERENCES auth."sessions"("id"),
  "userId" TEXT REFERENCES auth."users"("id"),
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" JSONB,
  "requestedUserInfoClaims" JSONB,
  "refreshId" TEXT REFERENCES auth."oauthRefreshToken"("id"),
  "expiresAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ,
  "revoked" TIMESTAMPTZ,
  "confirmation" JSONB,
  "scopes" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS auth."oauthConsent" (
  "id" TEXT PRIMARY KEY,
  "clientId" TEXT NOT NULL REFERENCES auth."oauthClient"("clientId"),
  "userId" TEXT REFERENCES auth."users"("id"),
  "referenceId" TEXT,
  "resources" JSONB,
  "requestedUserInfoClaims" JSONB,
  "scopes" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth."oauthClientAssertion" (
  "id" TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ NOT NULL
);


--rollback DROP TABLE IF EXISTS auth."oauthClientAssertion"; DROP TABLE IF EXISTS auth."oauthConsent"; DROP TABLE IF EXISTS auth."oauthAccessToken"; DROP TABLE IF EXISTS auth."oauthRefreshToken"; DROP TABLE IF EXISTS auth."oauthClientResource"; DROP TABLE IF EXISTS auth."oauthResource"; DROP TABLE IF EXISTS auth."oauthClient";
