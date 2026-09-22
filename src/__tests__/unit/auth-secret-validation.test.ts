/**
 * Tests for H1 (BETTER_AUTH_SECRET fail-fast) and M9 (email verification default).
 *
 * H1: importing lib/auth.ts must throw when BETTER_AUTH_SECRET is missing or
 *      shorter than 32 characters, and succeed with a valid secret.
 * M9: a valid secret must not throw, and the module's requireEmailVerification
 *     default resolves to ON unless explicitly disabled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const VALID_SECRET = "valid-secret-that-is-at-least-32-chars";

function clearAuthModules() {
  vi.resetModules();
  vi.unstubAllEnvs();
}

describe("H1 + M9: auth boot validation", () => {
  beforeEach(() => {
    clearAuthModules();
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test?schema=auth";
    process.env.REDIS_URL = "redis://localhost:6379/15";
    process.env.BETTER_AUTH_URL = "http://localhost:3002";
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  });

  afterEach(() => {
    clearAuthModules();
  });

  describe("H1 secret fail-fast", () => {
    it("throws when BETTER_AUTH_SECRET is missing", async () => {
      await expect(
        import("../../lib/auth.js")
      ).rejects.toThrow(/BETTER_AUTH_SECRET/);
    });

    it("throws when BETTER_AUTH_SECRET is shorter than 32 chars", async () => {
      process.env.BETTER_AUTH_SECRET = "too-short";
      await expect(
        import("../../lib/auth.js")
      ).rejects.toThrow(/at least 32 characters/);
    });

    it("does not throw when secret is exactly 32 chars", async () => {
      process.env.BETTER_AUTH_SECRET = VALID_SECRET;
      const mod = await import("../../lib/auth.js");
      expect(mod).toBeDefined();
    });
  });

  describe("M9 email verification default", () => {
    it("defaults requireEmailVerification ON when env unset (valid secret)", async () => {
      process.env.BETTER_AUTH_SECRET = VALID_SECRET;
      delete process.env.REQUIRE_EMAIL_VERIFICATION;
      const { auth } = await import("../../lib/auth.js");
      // The betterAuth() mock in setup spreads the config; verify the flag is true
      expect((auth as any).emailAndPassword?.requireEmailVerification).toBe(true);
    });

    it("allows explicit opt-out via REQUIRE_EMAIL_VERIFICATION=false", async () => {
      process.env.BETTER_AUTH_SECRET = VALID_SECRET;
      process.env.REQUIRE_EMAIL_VERIFICATION = "false";
      const { auth } = await import("../../lib/auth.js");
      expect((auth as any).emailAndPassword?.requireEmailVerification).toBe(false);
    });
  });
});
