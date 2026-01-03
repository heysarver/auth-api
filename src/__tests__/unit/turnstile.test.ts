/**
 * Unit tests for lib/turnstile.ts
 * Tests Cloudflare Turnstile token verification
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock redis module
const mockRedisGet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisSetex = vi.fn();

vi.mock("../../lib/redis.js", () => ({
  redis: {
    get: mockRedisGet,
    del: mockRedisDel,
    setex: mockRedisSetex,
  },
}));

describe("lib/turnstile.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    (global.fetch as any).mockReset();
    // Reset redis mocks
    mockRedisGet.mockReset();
    mockRedisDel.mockReset();
    mockRedisSetex.mockReset();
    // Default: cache miss
    mockRedisGet.mockResolvedValue(null);
    mockRedisDel.mockResolvedValue(1);
    mockRedisSetex.mockResolvedValue("OK");
    // Reset environment variables
    delete process.env.TURNSTILE_ENABLED;
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  describe("verifyTurnstileToken", () => {
    it("should return true when Turnstile is disabled", async () => {
      process.env.TURNSTILE_ENABLED = "false";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      const result = await verifyTurnstileToken("any-token");

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile verification disabled")
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return false when secret key is not configured and Turnstile is enabled", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      // No TURNSTILE_SECRET_KEY set

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      const result = await verifyTurnstileToken("any-token");

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("TURNSTILE_SECRET_KEY not configured")
      );
    });

    it("should return false for invalid token format", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      // Test with empty string
      let result = await verifyTurnstileToken("");
      expect(result).toBe(false);

      // Test with non-string
      result = await verifyTurnstileToken(null as any);
      expect(result).toBe(false);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid Turnstile token format")
      );
    });

    it("should accept development mode bypass token", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      const result = await verifyTurnstileToken("DEVELOPMENT_MODE_BYPASS");

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("development mode bypass token accepted")
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should verify token with Cloudflare API successfully", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          challenge_ts: "2024-01-01T00:00:00Z",
          hostname: "example.com",
        }),
      });

      const result = await verifyTurnstileToken("valid-token", "192.168.1.1");

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        })
      );

      // Verify request body contains secret, response, and remoteip
      const fetchCall = (global.fetch as any).mock.calls[0];
      const requestBody = fetchCall[1].body;
      expect(requestBody).toContain("secret=test-secret-key");
      expect(requestBody).toContain("response=valid-token");
      expect(requestBody).toContain("remoteip=192.168.1.1");

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile verification successful")
      );
    });

    it("should verify token without remoteip parameter", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await verifyTurnstileToken("valid-token");

      expect(result).toBe(true);

      const fetchCall = (global.fetch as any).mock.calls[0];
      const requestBody = fetchCall[1].body;
      expect(requestBody).not.toContain("remoteip");
    });

    it("should return false when Cloudflare API returns unsuccessful response", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          "error-codes": ["invalid-input-response", "timeout-or-duplicate"],
        }),
      });

      const result = await verifyTurnstileToken("invalid-token");

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile verification failed"),
        expect.arrayContaining(["invalid-input-response", "timeout-or-duplicate"])
      );
    });

    it("should handle HTTP error responses", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await verifyTurnstileToken("test-token");

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile verification request failed")
      );
    });

    it("should handle network errors", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const result = await verifyTurnstileToken("test-token");

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile verification error"),
        expect.any(Error)
      );
    });

    it("should handle malformed JSON responses", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      });

      const result = await verifyTurnstileToken("test-token");

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile verification error"),
        expect.any(Error)
      );
    });

    it("should handle response with missing success field", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({}), // Missing success field
      });

      const result = await verifyTurnstileToken("test-token");

      expect(result).toBe(false);
    });

    it("should return cached result and delete cache entry on cache hit", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      // Simulate cache hit with "true" value
      mockRedisGet.mockResolvedValue("true");

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      const result = await verifyTurnstileToken("cached-token", "192.168.1.1");

      expect(result).toBe(true);
      // Verify cache was checked
      expect(mockRedisGet).toHaveBeenCalledWith(
        expect.stringMatching(/^turnstile:[a-f0-9]+:192\.168\.1\.1$/)
      );
      // Verify cache entry was deleted (single-use)
      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringMatching(/^turnstile:[a-f0-9]+:192\.168\.1\.1$/)
      );
      // Verify Cloudflare API was NOT called
      expect(global.fetch).not.toHaveBeenCalled();
      // Verify log message
      expect(console.log).toHaveBeenCalledWith("Turnstile verification cache hit");
    });

    it("should call Cloudflare API on cache miss", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      // Simulate cache miss
      mockRedisGet.mockResolvedValue(null);

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await verifyTurnstileToken("new-token", "192.168.1.1");

      expect(result).toBe(true);
      // Verify cache was checked
      expect(mockRedisGet).toHaveBeenCalled();
      // Verify Cloudflare API WAS called
      expect(global.fetch).toHaveBeenCalledWith(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        expect.any(Object)
      );
      // Verify result was cached
      expect(mockRedisSetex).toHaveBeenCalledWith(
        expect.stringMatching(/^turnstile:[a-f0-9]+:192\.168\.1\.1$/),
        600, // 10 minutes TTL
        "true"
      );
    });

    it("should NOT cache failed verifications", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      // Simulate cache miss
      mockRedisGet.mockResolvedValue(null);

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          "error-codes": ["invalid-input-response"],
        }),
      });

      const result = await verifyTurnstileToken("invalid-token", "192.168.1.1");

      expect(result).toBe(false);
      // Verify result was NOT cached
      expect(mockRedisSetex).not.toHaveBeenCalled();
    });

    it("should use 'unknown' as client IP when remoteip is not provided for cache key", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      // Simulate cache miss
      mockRedisGet.mockResolvedValue(null);

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      await verifyTurnstileToken("new-token"); // No remoteip

      // Verify cache key uses "unknown" as client IP
      expect(mockRedisGet).toHaveBeenCalledWith(
        expect.stringMatching(/^turnstile:[a-f0-9]+:unknown$/)
      );
    });

    it("should continue with API verification if cache read fails", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      // Simulate cache error
      mockRedisGet.mockRejectedValue(new Error("Redis connection error"));

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await verifyTurnstileToken("test-token", "192.168.1.1");

      expect(result).toBe(true);
      // Verify Cloudflare API was called despite cache error
      expect(global.fetch).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile cache error"),
        expect.any(Error)
      );
    });

    it("should continue successfully if cache write fails after successful verification", async () => {
      process.env.TURNSTILE_ENABLED = "true";
      process.env.TURNSTILE_SECRET_KEY = "test-secret-key";

      // Simulate cache miss on read
      mockRedisGet.mockResolvedValue(null);
      // Simulate cache write failure
      mockRedisSetex.mockRejectedValue(new Error("Redis write error"));

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await verifyTurnstileToken("test-token", "192.168.1.1");

      // Verification should still succeed even if caching fails
      expect(result).toBe(true);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to cache Turnstile verification"),
        expect.any(Error)
      );
    });
  });
});
