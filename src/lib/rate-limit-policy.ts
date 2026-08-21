// Session-token refresh is authenticated by the HttpOnly session cookie. In
// shared-NAT deployments, an IP bucket can otherwise lock every browser out.
export const betterAuthRateLimitCustomRules = {
  "/token": false,
  "/get-session": false,
} as const;

export function skipsSharedIpRateLimit(path: string): boolean {
  return path === "/token" || path === "/get-session";
}
