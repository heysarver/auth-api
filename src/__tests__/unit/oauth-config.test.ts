import { describe, expect, it } from "vitest";

import { resolveGoogleRedirectURI } from "../../lib/oauth-config.js";

describe("Google OAuth configuration", () => {
  it("uses an explicit public callback URL", () => {
    expect(
      resolveGoogleRedirectURI({
        GOOGLE_REDIRECT_URI:
          "https://staging.morningshepherd.com/api/auth/callback/google",
      }),
    ).toBe("https://staging.morningshepherd.com/api/auth/callback/google");
  });

  it("allows Better Auth to use its default when no override is configured", () => {
    expect(resolveGoogleRedirectURI({})).toBeUndefined();
  });

  it.each(["not-a-url", "javascript:alert(1)"])(
    "rejects an unsafe redirect URI: %s",
    (configuredValue) => {
      expect(() =>
        resolveGoogleRedirectURI({ GOOGLE_REDIRECT_URI: configuredValue }),
      ).toThrow(/GOOGLE_REDIRECT_URI/);
    },
  );
});
