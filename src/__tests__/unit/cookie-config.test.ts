import { describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import { buildAdvancedCookieOptions } from "../../lib/cookie-config.js";

describe("Better Auth cookie configuration", () => {
  it("preserves the cross-subdomain Domain attribute in staging", () => {
    const advanced = buildAdvancedCookieOptions({
      NODE_ENV: "staging",
      COOKIE_DOMAIN: "staging.saasideafinder.com",
      COOKIE_PREFIX: "better-auth",
    });

    expect(advanced.defaultCookieAttributes).not.toHaveProperty("domain");

    const cookies = getCookies({
      baseURL: "https://auth.staging.saasideafinder.com",
      advanced,
    } as BetterAuthOptions);

    expect(cookies.sessionToken.name).toBe("__Secure-better-auth.session_token");
    expect(cookies.sessionToken.attributes).toMatchObject({
      domain: ".staging.saasideafinder.com",
      httpOnly: true,
      path: "/",
      sameSite: "none",
      secure: true,
    });
  });

  it("leaves development cookies scoped to the request host", () => {
    const advanced = buildAdvancedCookieOptions({
      NODE_ENV: "development",
      COOKIE_PREFIX: "better-auth",
    });

    const cookies = getCookies({
      baseURL: "http://localhost:3002",
      advanced,
    } as BetterAuthOptions);

    expect(cookies.sessionToken.attributes).not.toHaveProperty("domain");
    expect(cookies.sessionToken.attributes).toMatchObject({
      sameSite: "lax",
      secure: false,
    });
  });
});
