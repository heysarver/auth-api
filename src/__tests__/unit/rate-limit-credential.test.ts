/**
 * Unit tests for middleware/rate-limit-credential.ts
 * Verifies the per-credential (email) rate limit middleware behavior.
 *
 * The shared ioredis mock in setup.ts emulates the two raw commands the
 * rate-limit-redis store issues, driven by redisRateLimitState.currentHits:
 *   - ["SCRIPT", "LOAD", <lua>]  -> a SHA string
 *   - ["EVALSHA", sha, "1", key, ...] -> [totalHits, ttlMs]
 * Setting redisRateLimitState.currentHigh pre-loads the hit counter so a test
 * can exercise the "already over the limit" path deterministically.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRedisCall, redisRateLimitState } from "../setup.js";
import {
  credentialRateLimitMiddleware,
  normalizeEmail,
  credentialRateLimitConfig,
} from "../../middleware/rate-limit-credential.js";

const TEST_MAX = 3;
const TEST_WINDOW_MS = 60_000;

describe("middleware/rate-limit-credential.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    process.env.CREDENTIAL_RATE_LIMIT_MAX = String(TEST_MAX);
    process.env.CREDENTIAL_RATE_LIMIT_WINDOW_SEC = "60";
    redisRateLimitState.currentHits = 0;
    redisRateLimitState.windowMs = TEST_WINDOW_MS;
    mockRedisCall.mockClear();
  });

  describe("normalizeEmail", () => {
    it("lowercases and trims", () => {
      expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
    });
    it("returns null for non-strings", () => {
      expect(normalizeEmail(undefined)).toBeNull();
      expect(normalizeEmail(42)).toBeNull();
      expect(normalizeEmail(null)).toBeNull();
    });
    it("returns null for empty/whitespace", () => {
      expect(normalizeEmail("")).toBeNull();
      expect(normalizeEmail("   ")).toBeNull();
    });
  });

  describe("credentialRateLimitConfig", () => {
    it("reads max from CREDENTIAL_RATE_LIMIT_MAX", () => {
      expect(credentialRateLimitConfig.max).toBe(TEST_MAX);
    });
    it("reads window from CREDENTIAL_RATE_LIMIT_WINDOW_SEC (ms)", () => {
      expect(credentialRateLimitConfig.windowMs).toBe(TEST_WINDOW_MS);
    });
  });

  describe("credentialRateLimitMiddleware", () => {
    function reqFor(path: string, email?: string) {
      return {
        path,
        body: email ? { email } : {},
        method: "POST",
        headers: {},
      } as any;
    }
    function makeRes() {
      return {
        setHeader: vi.fn(),
        send: vi.fn().mockReturnThis(),
        end: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        on: vi.fn(),
      } as any;
    }

    it("passes through non-credential paths without touching redis", () => {
      const next = vi.fn();
      credentialRateLimitMiddleware(
        reqFor("/sign-up/email", "a@example.com"),
        makeRes(),
        next
      );
      expect(mockRedisCall).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("passes through credential paths with no email", () => {
      const next = vi.fn();
      credentialRateLimitMiddleware(
        reqFor("/sign-in/email"),
        makeRes(),
        next
      );
      expect(mockRedisCall).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("allows the first request for a new email (hits=0 < max)", async () => {
      redisRateLimitState.currentHits = 0;
      const next = vi.fn();
      await credentialRateLimitMiddleware(
        reqFor("/sign-in/email", "fresh@example.com"),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("allows a request under the limit (hits=max-1 < max)", async () => {
      redisRateLimitState.currentHits = TEST_MAX - 1;
      const next = vi.fn();
      await credentialRateLimitMiddleware(
        reqFor("/sign-in/email", "ok@example.com"),
        makeRes(),
        next
      );
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("blocks with 429 when hits exceeds max", async () => {
      // express-rate-limit blocks when totalHits > limit (strictly greater),
      // so the counter must be at max+1 to trip the 429.
      redisRateLimitState.currentHits = TEST_MAX + 1;
      const res = makeRes();
      const next = vi.fn();
      await credentialRateLimitMiddleware(
        reqFor("/request-password-reset", "victim@example.com"),
        res,
        next
      );
      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();
    });

    it("blocks with 429 for a different email (keyed per credential)", async () => {
      redisRateLimitState.currentHits = TEST_MAX + 1;
      const res = makeRes();
      const next = vi.fn();
      await credentialRateLimitMiddleware(
        reqFor("/sign-in/email", "other-victim@example.com"),
        res,
        next
      );
      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
