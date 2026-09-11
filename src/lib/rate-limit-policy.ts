// Session-token refresh is authenticated by the HttpOnly session cookie. In
// shared-NAT deployments, an IP bucket can otherwise lock every browser out.
export const betterAuthRateLimitCustomRules = {
  "/token": false,
} as const;

export function skipsSharedIpRateLimit(path: string, method = "GET"): boolean {
  // Introspection has its own short-window limiter. Counting its continuous
  // service traffic here would exhaust the browser bucket during normal use.
  return path === "/token" || (method === "POST" &&
    (path === "/token/introspect" || path === "/token/introspect/"));
}
