import type { BetterAuthOptions } from "better-auth";

type AccountLinkingOptions = NonNullable<
  NonNullable<BetterAuthOptions["account"]>["accountLinking"]
>;

/**
 * Link a social identity only when Better Auth can prove both sides own the
 * same verified email address. No provider bypasses the verification checks.
 */
export const matchingVerifiedEmailAccountLinking: AccountLinkingOptions = {
  enabled: true,
  disableImplicitLinking: false,
  trustedProviders: [],
  allowDifferentEmails: false,
  requireLocalEmailVerified: true,
  updateUserInfoOnLink: false,
};
