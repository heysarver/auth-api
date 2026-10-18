import { describe, expect, it } from "vitest";
import {
  getPublicAuthPolicy,
  isEmailVerificationRequired,
} from "../../lib/email-verification-policy.js";

describe("email verification policy", () => {
  it("requires verification when the flag is unset (fail-safe default)", () => {
    expect(isEmailVerificationRequired({})).toBe(true);
    expect(getPublicAuthPolicy({})).toEqual({ emailVerificationRequired: true });
  });

  it("requires verification when the flag is empty or unrecognized", () => {
    expect(isEmailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: "" })).toBe(true);
    expect(isEmailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: "FALSE" })).toBe(true);
    expect(isEmailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: "no" })).toBe(true);
  });

  it("keeps verification required for an explicit true", () => {
    expect(isEmailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: "true" })).toBe(true);
    expect(getPublicAuthPolicy({ REQUIRE_EMAIL_VERIFICATION: "true" })).toEqual({
      emailVerificationRequired: true,
    });
  });

  it("disables the requirement only for the literal false", () => {
    expect(isEmailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: "false" })).toBe(false);
    expect(getPublicAuthPolicy({ REQUIRE_EMAIL_VERIFICATION: "false" })).toEqual({
      emailVerificationRequired: false,
    });
  });

  it("reports the same decision the auth configuration applies", () => {
    // Production and default deploys keep enforcement on.
    expect(getPublicAuthPolicy({}).emailVerificationRequired).toBe(true);
    // Local opt-out is explicit and testable.
    expect(getPublicAuthPolicy({ REQUIRE_EMAIL_VERIFICATION: "false" }).emailVerificationRequired).toBe(
      false,
    );
  });
});
