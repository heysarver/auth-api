/**
 * Unit tests for middleware/turnstile.ts
 * Tests Express middleware for Turnstile token validation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRequest, createMockResponse, createMockNext } from "../setup.js";

// Mock the turnstile module
vi.mock("../../lib/turnstile.js", () => ({
  verifyTurnstileToken: vi.fn(),
}));

describe("middleware/turnstile.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TURNSTILE_ENABLED;
  });

  describe("validateTurnstileToken middleware", () => {
    it("should skip validation for non-auth endpoints", async () => {
      vi.resetModules();
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      const req = createMockRequest({
        path: "/health",
        method: "GET",
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should skip validation for session endpoint", async () => {
      vi.resetModules();
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      const req = createMockRequest({
        path: "/session",
        method: "GET",
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should validate token on sign-up endpoint", async () => {
      process.env.TURNSTILE_ENABLED = "true";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      (verifyTurnstileToken as any).mockResolvedValue(true);

      const req = createMockRequest({
        path: "/sign-up/email",
        method: "POST",
        body: {
          "cf-turnstile-response": "valid-token",
          email: "test@example.com",
          password: "password123",
        },
        ip: "192.168.1.1",
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(verifyTurnstileToken).toHaveBeenCalledWith(
        "valid-token",
        "192.168.1.1"
      );
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should validate token on sign-in endpoint", async () => {
      process.env.TURNSTILE_ENABLED = "true";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      (verifyTurnstileToken as any).mockResolvedValue(true);

      const req = createMockRequest({
        path: "/sign-in/email",
        method: "POST",
        body: {
          "cf-turnstile-response": "valid-token",
          email: "test@example.com",
          password: "password123",
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(verifyTurnstileToken).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it("should return 400 when token is missing and Turnstile is enabled", async () => {
      process.env.TURNSTILE_ENABLED = "true";

      vi.resetModules();
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      const req = createMockRequest({
        path: "/sign-up/email",
        method: "POST",
        body: {
          email: "test@example.com",
          password: "password123",
          // No cf-turnstile-response
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "Bad Request",
        message: "Turnstile verification required",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should allow request without token when Turnstile is disabled", async () => {
      process.env.TURNSTILE_ENABLED = "false";

      vi.resetModules();
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      const req = createMockRequest({
        path: "/sign-up/email",
        method: "POST",
        body: {
          email: "test@example.com",
          password: "password123",
          // No cf-turnstile-response
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile disabled - allowing request without token")
      );
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return 403 when token verification fails", async () => {
      process.env.TURNSTILE_ENABLED = "true";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      (verifyTurnstileToken as any).mockResolvedValue(false);

      const req = createMockRequest({
        path: "/sign-up/email",
        method: "POST",
        body: {
          "cf-turnstile-response": "invalid-token",
          email: "test@example.com",
          password: "password123",
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Forbidden",
        message: "Turnstile verification failed. Please try again.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("should use socket.remoteAddress when req.ip is not available", async () => {
      process.env.TURNSTILE_ENABLED = "true";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      (verifyTurnstileToken as any).mockResolvedValue(true);

      const req = {
        path: "/sign-up/email",
        method: "POST",
        body: {
          "cf-turnstile-response": "valid-token",
        },
        ip: undefined, // No ip
        socket: {
          remoteAddress: "10.0.0.1",
        },
      };
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(verifyTurnstileToken).toHaveBeenCalledWith("valid-token", "10.0.0.1");
      expect(next).toHaveBeenCalled();
    });

    it("should log warnings when token is missing", async () => {
      process.env.TURNSTILE_ENABLED = "false";

      vi.resetModules();
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      const req = createMockRequest({
        path: "/sign-in/email",
        method: "POST",
        body: {},
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("No Turnstile token provided"),
        expect.any(String)
      );
    });

    it("should log success when verification passes", async () => {
      process.env.TURNSTILE_ENABLED = "true";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      (verifyTurnstileToken as any).mockResolvedValue(true);

      const req = createMockRequest({
        path: "/sign-in/email",
        method: "POST",
        body: {
          "cf-turnstile-response": "valid-token",
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile verification passed"),
        expect.any(String)
      );
    });

    it("should log errors when verification fails", async () => {
      process.env.TURNSTILE_ENABLED = "true";

      vi.resetModules();
      const { verifyTurnstileToken } = await import("../../lib/turnstile.js");
      const { validateTurnstileToken } = await import(
        "../../middleware/turnstile.js"
      );

      (verifyTurnstileToken as any).mockResolvedValue(false);

      const req = createMockRequest({
        path: "/sign-in/email",
        method: "POST",
        body: {
          "cf-turnstile-response": "invalid-token",
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await validateTurnstileToken(req as any, res as any, next);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Turnstile verification failed"),
        expect.any(String)
      );
    });
  });
});
