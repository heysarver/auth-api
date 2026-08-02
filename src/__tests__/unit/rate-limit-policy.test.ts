import { describe, expect, it } from "vitest";

import { betterAuthRateLimitCustomRules } from "../../lib/rate-limit-policy.js";

describe("browser authentication rate-limit policy", () => {
  it("does not place cookie-authenticated token refreshes in a shared IP bucket", () => {
    expect(betterAuthRateLimitCustomRules["/token"]).toBe(false);
  });
});
