/**
 * Regression + contract tests for the MarketKit opt-in OAuth-provider extension.
 *
 * These are REAL tests of the real module. `applyMarketKitOAuthExtension` builds
 * an actual `oauthProvider()` plugin (no options cast), and the compatibility
 * gate reads the INSTALLED provider version from the live plugin object, never
 * from configuration.
 *
 *  1. DEFAULT OFF — inert, plugins array returned by reference; no provider dep
 *     is exercised.
 *  2. Explicit config only — every value from MARKETKIT_OAUTH_*; fail closed.
 *  3. Version gate — malformed and prerelease versions are refused, and the
 *     floor is enforced (no env trust).
 *  4. PKCE — always required; the built plugin pins clientRegistrationRequirePKCE
 *     and there is no env switch to relax it.
 */
import { describe, it, expect } from "vitest";
import {
  MARKETKIT_OAUTH_ENV_PREFIX,
  PROVIDER_PATCHED_FLOOR,
  PROVIDER_ADVISORY_FLOOR,
  PROVIDER_ADVISORY_ID,
  resolveMarketKitOAuthConfig,
  parseSemver,
  assertProviderCompatible,
  createMarketKitOAuthProviderOptions,
  applyMarketKitOAuthExtension,
  type MarketKitOAuthConfig,
} from "../../lib/marketkit-oauth-provider.js";

const FULL_ENV: NodeJS.ProcessEnv = {
  MARKETKIT_OAUTH_ENABLED: "true",
  MARKETKIT_OAUTH_CLIENT_ID: "marketkit-mcp",
  MARKETKIT_OAUTH_CLIENT_NAME: "MarketKit MCP",
  MARKETKIT_OAUTH_REDIRECT_URIS: "https://mcp.marketkit.example/callback",
  MARKETKIT_OAUTH_ALLOWED_ORIGINS: "https://mcp.marketkit.example",
  MARKETKIT_OAUTH_RESOURCE: "https://mcp.marketkit.example",
  MARKETKIT_OAUTH_SCOPES: "mcp:tools,mcp:artifacts:read",
  MARKETKIT_OAUTH_CONSENT_PAGE: "/consent",
  MARKETKIT_OAUTH_LOGIN_PAGE: "/login",
};

describe("marketkit oauth provider extension — default OFF", () => {
  it("is inert when no MARKETKIT_OAUTH_* env is present", () => {
    expect(resolveMarketKitOAuthConfig({})).toBeNull();
  });

  it("is inert when MARKETKIT_OAUTH_ENABLED is not exactly 'true'", () => {
    expect(resolveMarketKitOAuthConfig({ MARKETKIT_OAUTH_ENABLED: "false" })).toBeNull();
    expect(resolveMarketKitOAuthConfig({ MARKETKIT_OAUTH_ENABLED: "1" })).toBeNull();
    expect(resolveMarketKitOAuthConfig({ MARKETKIT_OAUTH_ENABLED: "yes" })).toBeNull();
  });

  it("returns the existing plugin list unchanged (same reference) when disabled", () => {
    const existing = [{ id: "jwt" }];
    const result = applyMarketKitOAuthExtension(existing, {});
    expect(result).toBe(existing);
    expect(result).toHaveLength(1);
  });

  it("names the MARKETKIT env prefix", () => {
    expect(MARKETKIT_OAUTH_ENV_PREFIX).toBe("MARKETKIT_OAUTH_");
  });
});

describe("marketkit oauth provider extension — explicit config only", () => {
  it("refuses to enable without an explicit client id", () => {
    expect(() =>
      resolveMarketKitOAuthConfig({ ...FULL_ENV, MARKETKIT_OAUTH_CLIENT_ID: undefined }),
    ).toThrow(/MARKETKIT_OAUTH_CLIENT_ID/);
  });

  it("refuses to enable without an explicit resource/audience", () => {
    expect(() =>
      resolveMarketKitOAuthConfig({ ...FULL_ENV, MARKETKIT_OAUTH_RESOURCE: undefined }),
    ).toThrow(/MARKETKIT_OAUTH_RESOURCE/);
  });

  it("refuses to enable without an explicit redirect allowlist", () => {
    expect(() =>
      resolveMarketKitOAuthConfig({ ...FULL_ENV, MARKETKIT_OAUTH_REDIRECT_URIS: undefined }),
    ).toThrow(/MARKETKIT_OAUTH_REDIRECT_URIS/);
  });

  it("refuses to enable without an explicit consent page", () => {
    expect(() =>
      resolveMarketKitOAuthConfig({ ...FULL_ENV, MARKETKIT_OAUTH_CONSENT_PAGE: undefined }),
    ).toThrow(/MARKETKIT_OAUTH_CONSENT_PAGE/);
  });

  it("refuses to enable without an explicit login page", () => {
    expect(() =>
      resolveMarketKitOAuthConfig({ ...FULL_ENV, MARKETKIT_OAUTH_LOGIN_PAGE: undefined }),
    ).toThrow(/MARKETKIT_OAUTH_LOGIN_PAGE/);
  });

  it("refuses a wildcard redirect uri", () => {
    expect(() =>
      resolveMarketKitOAuthConfig({ ...FULL_ENV, MARKETKIT_OAUTH_REDIRECT_URIS: "https://*.example/cb" }),
    ).toThrow(/wildcard|exact/i);
  });

  it("refuses a non-https redirect uri", () => {
    expect(() =>
      resolveMarketKitOAuthConfig({ ...FULL_ENV, MARKETKIT_OAUTH_REDIRECT_URIS: "http://evil.example/cb" }),
    ).toThrow(/https/i);
  });

  it("refuses an absolute/wildcard consent page", () => {
    expect(() =>
      resolveMarketKitOAuthConfig({ ...FULL_ENV, MARKETKIT_OAUTH_CONSENT_PAGE: "https://evil.example/consent" }),
    ).toThrow(/consent/i);
  });

  it("parses an explicit config with zero upstream defaults", () => {
    const config = resolveMarketKitOAuthConfig(FULL_ENV) as MarketKitOAuthConfig;
    expect(config.resource).toBe("https://mcp.marketkit.example");
    expect(config.scopes).toEqual(["mcp:tools", "mcp:artifacts:read"]);
    expect(config.redirectUris).toEqual(["https://mcp.marketkit.example/callback"]);
    expect(config.consentPage).toBe("/consent");
  });
});

describe("marketkit oauth provider extension — REAL plugin composition", () => {
  it("builds options bound to the explicit MarketKit values", () => {
    const config = resolveMarketKitOAuthConfig(FULL_ENV) as MarketKitOAuthConfig;
    const options = createMarketKitOAuthProviderOptions(config);
    expect(options.resources).toEqual([
      { identifier: "https://mcp.marketkit.example", allowedScopes: ["mcp:tools", "mcp:artifacts:read"] },
    ]);
    expect(options.allowDynamicClientRegistration).toBe(false);
    expect(options.clientRegistrationRequirePKCE).toBe(true);
    expect(options.consentPage).toBe("/consent");
    expect(options.loginPage).toBe("/login");
    // No upstream default resource leaks in.
    expect(JSON.stringify(options.resources)).not.toContain("localhost");
  });

  it("appends an actual oauthProvider plugin (not an options cast) when ON", () => {
    const existing = [{ id: "jwt" }];
    const result = applyMarketKitOAuthExtension(existing, FULL_ENV);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(existing[0]);
    const plugin = result[1] as { id?: string; version?: string; schema?: unknown };
    expect(plugin.id).toBe("oauth-provider");
    // The real plugin runtime reports its installed version — the value the gate
    // consumed, which must equal the pinned floor.
    expect(plugin.version).toBe(PROVIDER_PATCHED_FLOOR);
    // A real plugin exposes a schema; a plain options object would not.
    expect(plugin.schema).toBeDefined();
  });
});

describe("marketkit oauth provider extension — version gate (GHSA-p2fr-6hmx-4528)", () => {
  it("exposes the advisory floor, pinned floor and advisory id", () => {
    expect(PROVIDER_ADVISORY_FLOOR).toBe("1.7.0");
    expect(PROVIDER_PATCHED_FLOOR).toBe("1.7.7");
    expect(PROVIDER_ADVISORY_ID).toBe("GHSA-p2fr-6hmx-4528");
  });

  it("rejects the pinned 1.6.23 identity", () => {
    expect(() => assertProviderCompatible("1.6.23")).toThrow(/1\.7\.7/);
    expect(() => assertProviderCompatible("1.6.23")).toThrow(/GHSA-p2fr-6hmx-4528/);
  });

  it("accepts the pinned patched release and newer stable releases", () => {
    expect(() => assertProviderCompatible("1.7.7")).not.toThrow();
    expect(() => assertProviderCompatible("1.7.8")).not.toThrow();
    expect(() => assertProviderCompatible("2.0.0")).not.toThrow();
  });

  it("rejects malformed versions rather than coercing them", () => {
    for (const bad of ["1.7", "1.7.x", "v1.7.7", "", " 1.7.7", "1.7.7-", "not-a-version"]) {
      expect(parseSemver(bad)).toBeNull();
      expect(() => assertProviderCompatible(bad)).toThrow(/not a valid semver/i);
    }
  });

  it("rejects any prerelease, even a high one", () => {
    expect(parseSemver("1.7.0-beta.9")?.prerelease).toBe("beta.9");
    expect(() => assertProviderCompatible("1.7.0-beta.9")).toThrow(/prerelease/i);
    expect(() => assertProviderCompatible("1.8.0-rc.1")).toThrow(/prerelease/i);
  });

  it("never trusts an env-supplied version (gate reads the plugin runtime)", () => {
    // A hostile env var must not influence the gate — the function signature no
    // longer accepts a version argument at all.
    const hostile: NodeJS.ProcessEnv = { ...FULL_ENV, MARKETKIT_OAUTH_PROVIDER_VERSION: "9.9.9" };
    const plugin = applyMarketKitOAuthExtension([], hostile)[0] as { version?: string };
    expect(plugin.version).toBe(PROVIDER_PATCHED_FLOOR);
  });
});
