/**
 * MarketKit OAuth-provider extension — OPT-IN, DEFAULT OFF.
 *
 * This module is the ONLY bridge between the shared, public `heysarver/auth-api`
 * identity service and MarketKit's need to act as an OAuth 2.1 authorization
 * server for its MCP surface. It is deliberately side-effect free and does NOT
 * statically import the OAuth-provider package, so the base service keeps running
 * on its pinned Better Auth 1.6.23 identity with no behavioural change.
 *
 * Design contract
 * ---------------
 * 1. DEFAULT OFF. Unless `MARKETKIT_OAUTH_ENABLED === "true"` the extension
 *    returns `null` / the caller's existing plugin list untouched. All existing
 *    consumers (app JWT RS256 + JWKS, email/password, Google social, sessions,
 *    workload DPoP) are byte-for-byte unaffected.
 * 2. EXPLICIT CONFIG ONLY. Audience/resource, scopes, origins, redirect URIs and
 *    the client are all read from `MARKETKIT_OAUTH_*` env and validated. Upstream
 *    defaults (localhost callback, dynamic registration, wildcard redirects) are
 *    never adopted.
 * 3. SECURITY GATE. The upstream OAuth-provider authorization was vulnerable to
 *    audience/resource selection not bound to the original user authorization
 *    (GHSA-p2fr-6hmx-4528) until 1.7.0. Enabling the extension against an older
 *    provider REFUSES rather than silently shipping an unpatched AS.
 * 4. FAIL CLOSED. A partial or malformed config throws at startup — it never
 *    invents a user, client, or resource.
 */

/** Env prefix for every MarketKit OAuth-provider setting. */
export const MARKETKIT_OAUTH_ENV_PREFIX = "MARKETKIT_OAUTH_";

/** First OAuth-provider release that fixes GHSA-p2fr-6hmx-4528. */
export const PROVIDER_PATCHED_FLOOR = "1.7.0";

/** The advisory that forces the version gate. */
export const PROVIDER_ADVISORY_ID = "GHSA-p2fr-6hmx-4528";

export interface MarketKitOAuthConfig {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  allowedOrigins: string[];
  resource: string;
  scopes: string[];
  clientRegistrationAllowedResources: string[];
  clientRegistrationAllowedScopes: string[];
  requirePKCE: boolean;
  consentRequired: boolean;
}

export interface MarketKitOAuthProviderOptions {
  __marketkit: true;
  scopes: string[];
  allowedResources: string[];
  clientRegistrationAllowedResources: string[];
  clientRegistrationAllowedScopes: string[];
  clientRegistrationRequirePKCE: boolean;
  allowDynamicClientRegistration: false;
  allowConsentPrompt: boolean;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(
      `${key} must be set explicitly when MARKETKIT_OAUTH_ENABLED=true ` +
        `(no upstream default is adopted).`,
    );
  }
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function assertHttpsAbsolute(value: string, key: string): void {
  if (value.includes("*")) {
    throw new Error(`${key} must use exact URIs; wildcard entries are not allowed.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must contain absolute URIs.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${key} entries must use https.`);
  }
  if (value.includes("#")) {
    throw new Error(`${key} entries must not contain a URL fragment.`);
  }
}

/**
 * Resolve the MarketKit OAuth-provider config from env, or `null` when the
 * extension is OFF. Throws (fail closed) on partial/invalid config.
 */
export function resolveMarketKitOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): MarketKitOAuthConfig | null {
  if (env.MARKETKIT_OAUTH_ENABLED !== "true") {
    return null;
  }

  const clientId = requireEnv(env, "MARKETKIT_OAUTH_CLIENT_ID");
  const clientName = requireEnv(env, "MARKETKIT_OAUTH_CLIENT_NAME");
  const resource = requireEnv(env, "MARKETKIT_OAUTH_RESOURCE");
  assertHttpsAbsolute(resource, "MARKETKIT_OAUTH_RESOURCE");

  const redirectUris = splitList(requireEnv(env, "MARKETKIT_OAUTH_REDIRECT_URIS"));
  if (redirectUris.length === 0) {
    throw new Error("MARKETKIT_OAUTH_REDIRECT_URIS must list at least one exact redirect URI.");
  }
  for (const uri of redirectUris) {
    assertHttpsAbsolute(uri, "MARKETKIT_OAUTH_REDIRECT_URIS");
  }

  const allowedOrigins = splitList(requireEnv(env, "MARKETKIT_OAUTH_ALLOWED_ORIGINS"));
  for (const origin of allowedOrigins) {
    assertHttpsAbsolute(origin, "MARKETKIT_OAUTH_ALLOWED_ORIGINS");
  }

  const scopes = splitList(requireEnv(env, "MARKETKIT_OAUTH_SCOPES"));

  const clientRegistrationAllowedResources = splitList(
    env.MARKETKIT_OAUTH_CLIENT_REGISTRATION_ALLOWED_RESOURCES?.trim() || resource,
  );
  const clientRegistrationAllowedScopes = splitList(
    env.MARKETKIT_OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES?.trim() ||
      scopes.join(","),
  );

  return {
    clientId,
    clientName,
    redirectUris,
    allowedOrigins,
    resource,
    scopes,
    clientRegistrationAllowedResources,
    clientRegistrationAllowedScopes,
    requirePKCE: env.MARKETKIT_OAUTH_REQUIRE_PKCE !== "false",
    consentRequired: env.MARKETKIT_OAUTH_CONSENT_REQUIRED !== "false",
  };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Assert the installed OAuth-provider is at or above the security floor.
 * Fails closed: anything below `PROVIDER_PATCHED_FLOOR` throws.
 */
export function assertProviderCompatible(providerVersion: string): void {
  if (compareVersions(providerVersion, PROVIDER_PATCHED_FLOOR) < 0) {
    throw new Error(
      `MarketKit OAuth-provider extension requires >= ${PROVIDER_PATCHED_FLOOR} ` +
        `(${PROVIDER_ADVISORY_ID}: resource/audience authorization not bound to the ` +
        `user's original authorization is unpatched below ${PROVIDER_PATCHED_FLOOR}). ` +
        `Installed: ${providerVersion}.`,
    );
  }
}

/**
 * Build the explicit oauthProvider() options. Every value traces back to
 * MarketKit config; no upstream default is adopted.
 */
export function createMarketKitOAuthProviderOptions(
  config: MarketKitOAuthConfig,
): MarketKitOAuthProviderOptions {
  return {
    __marketkit: true,
    scopes: [...config.scopes],
    allowedResources: [config.resource],
    clientRegistrationAllowedResources: [...config.clientRegistrationAllowedResources],
    clientRegistrationAllowedScopes: [...config.clientRegistrationAllowedScopes],
    clientRegistrationRequirePKCE: config.requirePKCE,
    // Dynamic registration is never silently enabled for the shared service.
    allowDynamicClientRegistration: false,
    allowConsentPrompt: config.consentRequired,
  };
}

/**
 * Compose the extension into an existing Better Auth plugin list.
 *
 * OFF  -> returns `existingPlugins` unchanged (same reference).
 * ON   -> gated on the provider security floor, then appends the MarketKit
 *         provider options. The caller is responsible for turning those options
 *         into the actual oauthProvider() plugin from the patched package, so
 *         this module stays free of a hard dependency on 1.7.x.
 */
export function applyMarketKitOAuthExtension<T>(
  existingPlugins: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
  providerVersion: string = "1.6.23",
): T[] {
  const config = resolveMarketKitOAuthConfig(env);
  if (!config) {
    return existingPlugins as T[];
  }
  assertProviderCompatible(providerVersion);
  return [
    ...existingPlugins,
    createMarketKitOAuthProviderOptions(config) as unknown as T,
  ];
}
