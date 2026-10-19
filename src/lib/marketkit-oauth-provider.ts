/**
 * MarketKit OAuth-provider extension — OPT-IN, DEFAULT OFF.
 *
 * REAL composition: unlike the earlier placeholder this module builds an actual
 * `oauthProvider()` plugin from `@better-auth/oauth-provider` and returns the
 * live plugin object. There is no options-object cast; the value appended to the
 * plugin list is the object the provider runtime produced (id `oauth-provider`,
 * carrying its own installed `version`).
 *
 * Because this module statically imports the provider package it can only be
 * compiled in the OPTIONAL extension build (see Dockerfile.marketkit, which pins
 * `@better-auth/oauth-provider@1.7.7` and its peer `better-auth@1.7.7`). The
 * default/shared service does not include this file's dependency and never
 * enables it.
 *
 * Design contract
 * ---------------
 * 1. DEFAULT OFF. Unless `MARKETKIT_OAUTH_ENABLED === "true"` the extension
 *    returns `null` and the caller's plugin list is returned unchanged (same
 *    reference). Existing JWT/JWKS, email/password, social, session and workload
 *    consumers are unaffected.
 * 2. EXPLICIT CONFIG ONLY. Resource/audience, scopes, origins and redirect URIs
 *    are read from `MARKETKIT_OAUTH_*` env and validated; upstream defaults
 *    (localhost callback, dynamic registration, wildcard redirects) are never
 *    adopted.
 * 3. SECURITY GATE. The provider fixes GHSA-p2fr-6hmx-4528 at >= 1.7.0. The gate
 *    reads the INSTALLED provider version (`plugin.version`) — never an env var —
 *    and refuses malformed versions, any prerelease, and anything below the
 *    pinned, end-to-end-verified floor.
 * 4. PKCE IS MANDATORY. There is no env switch to relax it. The plugin is built
 *    with `clientRegistrationRequirePKCE: true` and the seeded `oauth_clients`
 *    row is required to carry `requirePKCE = true` (migration default TRUE).
 * 5. FAIL CLOSED. Partial or malformed config throws at startup.
 */
import { oauthProvider, type OAuthOptions, type Scope } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";

/** Env prefix for every MarketKit OAuth-provider setting. */
export const MARKETKIT_OAUTH_ENV_PREFIX = "MARKETKIT_OAUTH_";

/** Advisory that forces the version gate. */
export const PROVIDER_ADVISORY_ID = "GHSA-p2fr-6hmx-4528";

/** Advisory floor: first release that fixes GHSA-p2fr-6hmx-4528. */
export const PROVIDER_ADVISORY_FLOOR = "1.7.0";

/**
 * Pinned floor actually shipped and verified end-to-end by this build. The gate
 * requires the installed provider to be at least this stable release.
 */
export const PROVIDER_PATCHED_FLOOR = "1.7.7";

export interface MarketKitOAuthConfig {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  allowedOrigins: string[];
  resource: string;
  scopes: string[];
  consentPage: string;
  loginPage: string;
}

/** Parsed, validated semver. `prerelease` is the raw suffix or `null`. */
export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

/** The live plugin object returned by the real `oauthProvider()` factory. */
export type MarketKitOAuthProviderPlugin = ReturnType<typeof oauthProvider>;

const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Strictly parse a semver string. Returns `null` for anything malformed — a
 * missing component, non-numeric core, empty prerelease id, bad characters, or
 * surrounding whitespace. Callers MUST treat `null` as a hard failure.
 */
export function parseSemver(value: string): ParsedSemver | null {
  if (typeof value !== "string") return null;
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? null,
  };
}

function compareCore(a: ParsedSemver, b: ParsedSemver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Assert the INSTALLED provider version is a stable release at or above the
 * pinned floor. Fails closed on malformed input and on any prerelease.
 */
export function assertProviderCompatible(providerVersion: string): void {
  const installed = parseSemver(providerVersion);
  if (!installed) {
    throw new Error(
      `MarketKit OAuth-provider extension: installed provider version ` +
        `"${providerVersion}" is not a valid semver; refusing to trust an ` +
        `unparseable version (${PROVIDER_ADVISORY_ID}).`,
    );
  }
  if (installed.prerelease) {
    throw new Error(
      `MarketKit OAuth-provider extension: prerelease provider "${providerVersion}" ` +
        `is not accepted; use a stable release >= ${PROVIDER_PATCHED_FLOOR} ` +
        `(${PROVIDER_ADVISORY_ID}).`,
    );
  }
  const floor = parseSemver(PROVIDER_PATCHED_FLOOR) as ParsedSemver;
  if (compareCore(installed, floor) < 0) {
    throw new Error(
      `MarketKit OAuth-provider extension requires >= ${PROVIDER_PATCHED_FLOOR} ` +
        `(${PROVIDER_ADVISORY_ID}: resource/audience authorization not bound to the ` +
        `user's original authorization is unpatched below ${PROVIDER_ADVISORY_FLOOR}). ` +
        `Installed: ${providerVersion}.`,
    );
  }
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

function assertRelativePath(value: string, key: string): void {
  if (!value.startsWith("/") || value.startsWith("//") || value.endsWith("/")) {
    throw new Error(`${key} must be a single rooted path such as "/consent".`);
  }
  if (value.includes("*") || value.includes("://")) {
    throw new Error(`${key} must be a site-relative path, not an absolute or wildcard URL.`);
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
  if (scopes.length === 0) {
    throw new Error("MARKETKIT_OAUTH_SCOPES must list at least one scope.");
  }

  const consentPage = requireEnv(env, "MARKETKIT_OAUTH_CONSENT_PAGE");
  assertRelativePath(consentPage, "MARKETKIT_OAUTH_CONSENT_PAGE");
  const loginPage = requireEnv(env, "MARKETKIT_OAUTH_LOGIN_PAGE");
  assertRelativePath(loginPage, "MARKETKIT_OAUTH_LOGIN_PAGE");

  return {
    clientId,
    clientName,
    redirectUris,
    allowedOrigins,
    resource,
    scopes,
    consentPage,
    loginPage,
  };
}

/**
 * Build the explicit `oauthProvider()` options. Every value traces back to
 * MarketKit config; no upstream default is adopted. PKCE and the "no dynamic
 * client registration" posture are unconditional.
 */
export function createMarketKitOAuthProviderOptions(
  config: MarketKitOAuthConfig,
): OAuthOptions<Scope[]> {
  return {
    scopes: [...config.scopes] as Scope[],
    resources: [{ identifier: config.resource, allowedScopes: [...config.scopes] }],
    clientRegistrationAllowedResources: [config.resource],
    clientRegistrationAllowedScopes: [...config.scopes] as Scope[],
    // Mandatory: dynamic clients, if they were ever enabled, must use PKCE.
    clientRegistrationRequirePKCE: true,
    // Dynamic client registration is never silently enabled for the shared service.
    allowDynamicClientRegistration: false,
    // Explicit consent/login surface; no upstream localhost default.
    consentPage: config.consentPage,
    loginPage: config.loginPage,
  };
}

/**
 * Compose the extension into an existing Better Auth plugin list.
 *
 * OFF -> returns `existingPlugins` unchanged (same reference).
 * ON  -> builds the REAL oauthProvider() plugin, verifies the INSTALLED provider
 *        version (from the plugin object itself, never env), and appends it.
 *
 * The caller passes a `BetterAuthPlugin[]`; the return type is
 * `BetterAuthPlugin[]`, so Better Auth's own option typing is unchanged.
 */
export function applyMarketKitOAuthExtension(
  existingPlugins: readonly BetterAuthPlugin[],
  env: NodeJS.ProcessEnv = process.env,
): BetterAuthPlugin[] {
  const config = resolveMarketKitOAuthConfig(env);
  if (!config) {
    return existingPlugins as BetterAuthPlugin[];
  }

  const plugin = oauthProvider(createMarketKitOAuthProviderOptions(config));

  // Read the version from the live plugin runtime, not from configuration: an
  // env-supplied version string is never trusted.
  const installedVersion = String((plugin as { version?: unknown }).version ?? "");
  assertProviderCompatible(installedVersion);

  return [...existingPlugins, plugin as unknown as BetterAuthPlugin];
}
