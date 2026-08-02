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

  it("keeps the shared IP limiter on unauthenticated and machine routes", () => {
    expect(skipsSharedIpRateLimit("/sign-in/email")).toBe(false);
    expect(skipsSharedIpRateLimit("/token/introspect")).toBe(false);
    expect(skipsSharedIpRateLimit("/workload/token")).toBe(false);
  });
});
