/**
 * Email verification policy.
 *
 * One place decides whether unverified accounts may sign in and use the product.
 * The public policy endpoint and the Better Auth configuration both read this
 * helper, so the UI contract and the server enforcement cannot drift apart.
 *
 * Fail-safe rule: only the literal string "false" turns enforcement off. An
 * unset, empty, misspelled, or non-string value keeps verification required, so
 * a bad deploy cannot silently admit unverified accounts.
 */

export const REQUIRE_EMAIL_VERIFICATION_ENV = "REQUIRE_EMAIL_VERIFICATION";

export function isEmailVerificationRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[REQUIRE_EMAIL_VERIFICATION_ENV] !== "false";
}

export interface PublicAuthPolicy {
  emailVerificationRequired: boolean;
}

export function getPublicAuthPolicy(
  env: Record<string, string | undefined> = process.env,
): PublicAuthPolicy {
  return { emailVerificationRequired: isEmailVerificationRequired(env) };
}
