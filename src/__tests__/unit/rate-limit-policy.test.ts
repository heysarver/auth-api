import { describe, expect, it } from "vitest";

import {
  betterAuthRateLimitCustomRules,
  skipsSharedIpRateLimit,
} from "../../lib/rate-limit-policy.js";

describe("browser authentication rate-limit policy", () => {
  it("does not place cookie-authenticated token refreshes in a shared IP bucket", () => {
    expect(betterAuthRateLimitCustomRules["/token"]).toBe(false);
    expect(skipsSharedIpRateLimit("/token")).toBe(true);
  });

  it("uses the dedicated limiter for both introspection route spellings", () => {
    expect(skipsSharedIpRateLimit("/token/introspect", "POST")).toBe(true);
    expect(skipsSharedIpRateLimit("/token/introspect/", "POST")).toBe(true);
  });

  it("keeps the shared IP limiter on unauthenticated and workload routes", () => {
    expect(skipsSharedIpRateLimit("/sign-in/email")).toBe(false);
    expect(skipsSharedIpRateLimit("/sign-up/email")).toBe(false);
    expect(skipsSharedIpRateLimit("/token/introspect/extra")).toBe(false);
    expect(skipsSharedIpRateLimit("/workload/token")).toBe(false);
  });

  it("rate limits direct session reads even when the caller disables cookie cache", () => {
    // Express request.path excludes the query string. Better Auth can force a
    // database read with disableCookieCache=true, so /get-session itself must
    // remain covered by both the shared limiter and Better Auth's limiter.
    expect(skipsSharedIpRateLimit("/get-session")).toBe(false);
    expect("/get-session" in betterAuthRateLimitCustomRules).toBe(false);
  });
});
