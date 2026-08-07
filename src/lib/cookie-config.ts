import type { BetterAuthOptions } from "better-auth";

type AdvancedCookieOptions = NonNullable<BetterAuthOptions["advanced"]>;

/**
 * Build Better Auth's cookie settings without overriding its computed
 * cross-subdomain Domain attribute with an explicit undefined value.
 */
export function buildAdvancedCookieOptions(
  env: NodeJS.ProcessEnv,
): AdvancedCookieOptions {
  const cookieDomain = env.COOKIE_DOMAIN?.trim();
  const isSecureEnvironment =
    env.NODE_ENV === "production" || env.NODE_ENV === "staging";

  return {
    cookiePrefix: env.COOKIE_PREFIX || "auth",
    useSecureCookies: isSecureEnvironment,
    crossSubDomainCookies: {
      enabled: Boolean(cookieDomain),
      ...(cookieDomain ? { domain: `.${cookieDomain.replace(/^\.+/, "")}` } : {}),
    },
    defaultCookieAttributes: {
      sameSite: env.NODE_ENV === "development" ? "lax" : "none",
      secure: env.NODE_ENV !== "development",
      httpOnly: true,
      partitioned: false,
      path: "/",
    },
  };
}
