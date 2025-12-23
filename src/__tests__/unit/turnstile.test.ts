/**
 * Unit tests for lib/turnstile.ts
 * Tests Cloudflare Turnstile token verification
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("lib/turnstile.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    (global.fetch as any).mockReset();
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
  });
});
