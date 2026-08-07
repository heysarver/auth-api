import { describe, expect, it } from "vitest";

import { auth } from "../../lib/auth.js";
import { matchingVerifiedEmailAccountLinking } from "../../lib/account-linking-config.js";
import { mapGoogleProfile, type GoogleProfile } from "../../lib/google-oauth-profile.js";

const googleProfile = (verifiedEmail: boolean): GoogleProfile => ({
  id: "google-user-123",
  name: "Existing Morning Shepherd User",
  email: "existing@example.com",
  picture: "https://example.com/avatar.png",
  verified_email: verifiedEmail,
});

describe("matching-email account linking", () => {
  it("installs the verified-email policy in Better Auth", () => {
    const configuredAuth = auth as unknown as {
      account: { accountLinking: typeof matchingVerifiedEmailAccountLinking };
    };

    expect(configuredAuth.account.accountLinking).toBe(
      matchingVerifiedEmailAccountLinking,
    );
  });

  it("allows implicit linking only for the same verified local email", () => {
    expect(matchingVerifiedEmailAccountLinking).toMatchObject({
      enabled: true,
      disableImplicitLinking: false,
      allowDifferentEmails: false,
      requireLocalEmailVerified: true,
      updateUserInfoOnLink: false,
    });
    expect(matchingVerifiedEmailAccountLinking.trustedProviders).toEqual([]);
  });

  it("preserves a verified Google email for Better Auth's linking decision", () => {
    expect(mapGoogleProfile(googleProfile(true)).user).toMatchObject({
      id: "google-user-123",
      email: "existing@example.com",
      emailVerified: true,
    });
  });

  it("does not trust an unverified Google email", () => {
    expect(mapGoogleProfile(googleProfile(false)).user.emailVerified).toBe(false);
  });
});
