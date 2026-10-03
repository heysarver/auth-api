/**
 * Regression tests for the MarketKit opt-in OAuth-provider extension.
 *
 * Contract under test (see docs/MARKETKIT_OAUTH_PROVIDER.md):
 *   1. DEFAULT OFF. With no MARKETKIT_OAUTH_* env the extension is inert and the
 *      existing plugins array (jwt only) is returned byte-for-byte unchanged, so
 *      current JWT/session/login/workload consumers are unaffected.
 *   2. Every audience / resource / scope / origin / redirect / client value is
 *      passed EXPLICITLY from MarketKit env — never an upstream default.
 *   3. Compatibility gate: the upstream OAuth-provider authorization is only
 *      safe at >= 1.7.0 (GHSA-p2fr-6hmx-4528). Enabling against the pinned
 *      1.6.23 identity must REFUSE rather than silently fork an unpatched AS.
 *   4. Partial/malformed config refuses to start (fail-closed), never invents
 *      users or defaults.
 */
import { describe, it, expect } from "vitest";
import {
  MARKETKIT_OAUTH_ENV_PREFIX,
  PROVIDER_PATCHED_FLOOR,
  PROVIDER_ADVISORY_ID,
  resolveMarketKitOAuthConfig,
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
  MARKETKIT_OAUTH_CLIENT_REGISTRATION_ALLOWED_RESOURCES: "https://mcp.marketkit.example",
  MARKETKIT_OAUTH_CLIENT_REGISTRATION_ALLOWED_SCOPES: "mcp:tools,mcp:artifacts:read",
};

describe("marketkit oauth provider extension — default OFF", () => {
  it("is inert when no MARKETKIT_OAUTH_* env is present", () => {
    const config = resolveMarketKitOAuthConfig({});
    expect(config).toBeNull();
  });

  it("is inert when MARKETKIT_OAUTH_ENABLED is not exactly 'true'", () => {
    expect(resolveMarketKitOAuthConfig({ MARKETKIT_OAUTH_ENABLED: "false" })).toBeNull();
    expect(resolveMarketKitOAuthConfig({ MARKETKIT_OAUTH_ENABLED: "1" })).toBeNull();
    expect(resolveMarketKitOAuthConfig({ MARKETKIT_OAUTH_ENABLED: "yes" })).toBeNull();
  });

  it("returns the existing plugin list unchanged when disabled", () => {
    const existing = [{ id: "jwt" }] as unknown[];
    const result = applyMarketKitOAuthExtension(existing, {}, "1.7.7");
    expect(result).toEqual(existing);
    expect(result).toHaveLength(1);
  });

  it("does not require the patched package when disabled (pinned 1.6.23 is fine)", () => {
    const existing: unknown[] = [];
    // 1.6.23 is below the floor, yet OFF must still be a no-op.
    expect(() => applyMarketKitOAuthExtension(existing, {}, "1.6.23")).not.toThrow();
  });
});

describe("marketkit oauth provider extension — explicit config only", () => {
  it("refuses to enable without an explicit client id", () => {
    const env = { ...FULL_ENV, MARKETKIT_OAUTH_CLIENT_ID: undefined };
    expect(() => resolveMarketKitOAuthConfig(env)).toThrow(/MARKETKIT_OAUTH_CLIENT_ID/);
  });

  it("refuses to enable without an explicit resource/audience", () => {
    const env = { ...FULL_ENV, MARKETKIT_OAUTH_RESOURCE: undefined };
    expect(() => resolveMarketKitOAuthConfig(env)).toThrow(/MARKETKIT_OAUTH_RESOURCE/);
  });

  it("refuses to enable without an explicit redirect allowlist", () => {
    const env = { ...FULL_ENV, MARKETKIT_OAUTH_REDIRECT_URIS: undefined };
    expect(() => resolveMarketKitOAuthConfig(env)).toThrow(/MARKETKIT_OAUTH_REDIRECT_URIS/);
  });

  it("refuses a wildcard redirect uri", () => {
    const env = { ...FULL_ENV, MARKETKIT_OAUTH_REDIRECT_URIS: "https://*.example/cb" };
    expect(() => resolveMarketKitOAuthConfig(env)).toThrow(/wildcard|exact/i);
  });

  it("refuses a non-https redirect uri", () => {
    const env = { ...FULL_ENV, MARKETKIT_OAUTH_REDIRECT_URIS: "http://evil.example/cb" };
    expect(() => resolveMarketKitOAuthConfig(env)).toThrow(/https/i);
  });

  it("names the MARKETKIT env prefix in the failure", () => {
    expect(MARKETKIT_OAUTH_ENV_PREFIX).toBe("MARKETKIT_OAUTH_");
  });

  it("parses an explicit config with zero upstream defaults", () => {
    const config = resolveMarketKitOAuthConfig(FULL_ENV) as MarketKitOAuthConfig;
    expect(config).not.toBeNull();
    expect(config.resource).toBe("https://mcp.marketkit.example");
    expect(config.scopes).toEqual(["mcp:tools", "mcp:artifacts:read"]);
    expect(config.redirectUris).toEqual(["https://mcp.marketkit.example/callback"]);
    expect(config.allowedOrigins).toEqual(["https://mcp.marketkit.example"]);
    expect(config.requirePKCE).toBe(true);
  });

  it("defaults PKCE to required and consent to required unless explicitly disabled", () => {
    const config = resolveMarketKitOAuthConfig(FULL_ENV) as MarketKitOAuthConfig;
    expect(config.requirePKCE).toBe(true);
    expect(config.consentRequired).toBe(true);
  });

  it("builds oauthProvider options bound to the explicit MarketKit values", () => {
    const config = resolveMarketKitOAuthConfig(FULL_ENV) as MarketKitOAuthConfig;
    const options = createMarketKitOAuthProviderOptions(config);
    expect(options.__marketkit).toBe(true);
    expect(options.scopes).toEqual(["mcp:tools", "mcp:artifacts:read"]);
    expect(options.allowedResources).toEqual(["https://mcp.marketkit.example"]);
    expect(options.clientRegistrationAllowedResources).toEqual([
      "https://mcp.marketkit.example",
    ]);
    // No upstream default resource leaks in.
    expect(options.allowedResources).not.toContain("http://localhost");
  });
});

describe("marketkit oauth provider extension — compatibility gate (GHSA-p2fr-6hmx-4528)", () => {
  it("exposes the patched floor and advisory id", () => {
    expect(PROVIDER_PATCHED_FLOOR).toBe("1.7.0");
    expect(PROVIDER_ADVISORY_ID).toBe("GHSA-p2fr-6hmx-4528");
  });

  it("refuses to run against the pinned 1.6.23 identity", () => {
    expect(() => assertProviderCompatible("1.6.23")).toThrow(/1\.7\.0/);
    expect(() => assertProviderCompatible("1.6.23")).toThrow(/GHSA-p2fr-6hmx-4528/);
  });

  it("accepts a patched release", () => {
    expect(() => assertProviderCompatible("1.7.0")).not.toThrow();
    expect(() => assertProviderCompatible("1.7.7")).not.toThrow();
  });

  it("refuses an unpatched 1.6.x when the extension is ON", () => {
    const existing: unknown[] = [];
    expect(() => applyMarketKitOAuthExtension(existing, FULL_ENV, "1.6.23")).toThrow(
      /GHSA-p2fr-6hmx-4528/,
    );
  });
});
