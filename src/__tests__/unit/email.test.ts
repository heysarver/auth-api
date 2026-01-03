/**
 * Unit tests for lib/email.ts
 * Tests SendGrid email sending functionality with various configurations
 * Tests cached EMAIL_CONFIG and template generator functions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockSendGridSend } from "../setup.js";

describe("lib/email.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables for each test
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_VERIFICATION_TEMPLATE_ID;
    delete process.env.SENDGRID_RESET_TEMPLATE_ID;
  });

  describe("EMAIL_CONFIG caching", () => {
    it("should cache configuration values at module load", async () => {
      // Set environment variables before importing
      process.env.APP_NAME = "CachedTestApp";
      process.env.PRODUCTION_DOMAIN = "cached-test.com";
      process.env.SUPPORT_EMAIL = "support@cached-test.com";
      process.env.BETTER_AUTH_URL = "http://localhost:4000";
      process.env.NODE_ENV = "test";

      vi.resetModules();
      const { EMAIL_CONFIG } = await import("../../lib/email.js");

      // Verify cached values
      expect(EMAIL_CONFIG.appName).toBe("CachedTestApp");
      expect(EMAIL_CONFIG.productionDomain).toBe("cached-test.com");
      expect(EMAIL_CONFIG.supportEmail).toBe("support@cached-test.com");
      expect(EMAIL_CONFIG.betterAuthUrl).toBe("http://localhost:4000");
      expect(EMAIL_CONFIG.nodeEnv).toBe("test");
    });

    it("should use default values when environment variables are not set", async () => {
      // Clear all relevant env vars
      delete process.env.APP_NAME;
      delete process.env.PRODUCTION_DOMAIN;
      delete process.env.SUPPORT_EMAIL;
      delete process.env.BETTER_AUTH_URL;
      delete process.env.NODE_ENV;

      vi.resetModules();
      const { EMAIL_CONFIG } = await import("../../lib/email.js");

      expect(EMAIL_CONFIG.appName).toBe("MyApp");
      expect(EMAIL_CONFIG.productionDomain).toBe("example.com");
      expect(EMAIL_CONFIG.supportEmail).toBe("support@example.com");
      expect(EMAIL_CONFIG.betterAuthUrl).toBe("http://localhost:3002");
      expect(EMAIL_CONFIG.nodeEnv).toBe("development");
    });

    it("should cache SendGrid template IDs", async () => {
      process.env.SENDGRID_VERIFICATION_TEMPLATE_ID = "d-verification-cached";
      process.env.SENDGRID_RESET_TEMPLATE_ID = "d-reset-cached";

      vi.resetModules();
      const { EMAIL_CONFIG } = await import("../../lib/email.js");

      expect(EMAIL_CONFIG.sendgridVerificationTemplateId).toBe("d-verification-cached");
      expect(EMAIL_CONFIG.sendgridResetTemplateId).toBe("d-reset-cached");
    });

    it("should be readonly (const assertion)", async () => {
      vi.resetModules();
      const { EMAIL_CONFIG } = await import("../../lib/email.js");

      // TypeScript const assertion makes properties readonly
      // This is a compile-time check, but we can verify the object structure
      expect(typeof EMAIL_CONFIG).toBe("object");
      expect(Object.isFrozen(EMAIL_CONFIG)).toBe(false); // Not frozen at runtime
    });
  });

  describe("Template generator functions", () => {
    describe("getVerificationEmailHtml", () => {
      it("should generate HTML with verification URL", async () => {
        process.env.APP_NAME = "TemplateTestApp";
        process.env.SUPPORT_EMAIL = "help@template.com";

        vi.resetModules();
        const { getVerificationEmailHtml } = await import("../../lib/email.js");

        const verificationUrl = "https://example.com/verify?token=test123";
        const html = getVerificationEmailHtml(verificationUrl);

        expect(html).toContain(verificationUrl);
        expect(html).toContain("Welcome to TemplateTestApp!");
        expect(html).toContain("help@template.com");
        expect(html).toContain("Verify Email");
        expect(html).toContain("This link will expire in 24 hours");
      });

      it("should include proper HTML structure", async () => {
        vi.resetModules();
        const { getVerificationEmailHtml } = await import("../../lib/email.js");

        const html = getVerificationEmailHtml("https://example.com/verify");

        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("<html>");
        expect(html).toContain("</html>");
        expect(html).toContain('<a href="https://example.com/verify"');
      });
    });

    describe("getVerificationEmailText", () => {
      it("should generate plain text with verification URL", async () => {
        process.env.APP_NAME = "TemplateTestApp";
        process.env.SUPPORT_EMAIL = "help@template.com";

        vi.resetModules();
        const { getVerificationEmailText } = await import("../../lib/email.js");

        const verificationUrl = "https://example.com/verify?token=test123";
        const text = getVerificationEmailText(verificationUrl);

        expect(text).toContain(verificationUrl);
        expect(text).toContain("Welcome to TemplateTestApp!");
        expect(text).toContain("help@template.com");
        expect(text).toContain("This link will expire in 24 hours");
      });

      it("should be trimmed with no leading/trailing whitespace", async () => {
        vi.resetModules();
        const { getVerificationEmailText } = await import("../../lib/email.js");

        const text = getVerificationEmailText("https://example.com/verify");

        expect(text).toBe(text.trim());
        expect(text.startsWith("\n")).toBe(false);
        expect(text.endsWith("\n")).toBe(false);
      });
    });

    describe("getPasswordResetEmailHtml", () => {
      it("should generate HTML with reset URL", async () => {
        process.env.SUPPORT_EMAIL = "help@reset.com";

        vi.resetModules();
        const { getPasswordResetEmailHtml } = await import("../../lib/email.js");

        const resetUrl = "https://example.com/reset?token=reset123";
        const html = getPasswordResetEmailHtml(resetUrl);

        expect(html).toContain(resetUrl);
        expect(html).toContain("Password Reset Request");
        expect(html).toContain("Reset Password");
        expect(html).toContain("help@reset.com");
        expect(html).toContain("This link will expire in 1 hour");
        expect(html).toContain("Important:");
      });

      it("should include security warning styling", async () => {
        vi.resetModules();
        const { getPasswordResetEmailHtml } = await import("../../lib/email.js");

        const html = getPasswordResetEmailHtml("https://example.com/reset");

        expect(html).toContain("warning");
        expect(html).toContain("#fff3cd"); // Warning background color
        expect(html).toContain("#ffc107"); // Warning border color
      });
    });

    describe("getPasswordResetEmailText", () => {
      it("should generate plain text with reset URL", async () => {
        process.env.SUPPORT_EMAIL = "help@reset.com";

        vi.resetModules();
        const { getPasswordResetEmailText } = await import("../../lib/email.js");

        const resetUrl = "https://example.com/reset?token=reset123";
        const text = getPasswordResetEmailText(resetUrl);

        expect(text).toContain(resetUrl);
        expect(text).toContain("Password Reset Request");
        expect(text).toContain("help@reset.com");
        expect(text).toContain("1 hour");
      });

      it("should be trimmed with no leading/trailing whitespace", async () => {
        vi.resetModules();
        const { getPasswordResetEmailText } = await import("../../lib/email.js");

        const text = getPasswordResetEmailText("https://example.com/reset");

        expect(text).toBe(text.trim());
        expect(text.startsWith("\n")).toBe(false);
        expect(text.endsWith("\n")).toBe(false);
      });
    });
  });

  describe("sendEmail", () => {
    it("should log email details when SendGrid is not configured", async () => {
      // Import after clearing env vars
      const { sendEmail } = await import("../../lib/email.js");

      await sendEmail({
        to: "test@example.com",
        subject: "Test Subject",
        text: "Test text",
        html: "<p>Test HTML</p>",
      });

      // Should not call SendGrid
      expect(mockSendGridSend).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Email would be sent")
      );
    });

    it("should send email with text and HTML when configured", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      process.env.SENDGRID_FROM_EMAIL = "noreply@test.com";
      process.env.SENDGRID_FROM_NAME = "Test App";

      // Clear module cache and reimport
      vi.resetModules();
      const { sendEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      await sendEmail({
        to: "recipient@example.com",
        subject: "Test Subject",
        text: "Test text content",
        html: "<p>Test HTML content</p>",
      });

      expect(mockSendGridSend).toHaveBeenCalledWith({
        to: "recipient@example.com",
        from: {
          email: "noreply@test.com",
          name: "Test App",
        },
        subject: "Test Subject",
        text: "Test text content",
        html: "<p>Test HTML content</p>",
      });
    });

    it("should send email with template when templateId is provided", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";

      vi.resetModules();
      const { sendEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      await sendEmail({
        to: "recipient@example.com",
        subject: "Test Subject",
        templateId: "d-abc123",
        dynamicTemplateData: {
          name: "John Doe",
          verification_url: "https://example.com/verify",
        },
      });

      expect(mockSendGridSend).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: "d-abc123",
          dynamicTemplateData: {
            name: "John Doe",
            verification_url: "https://example.com/verify",
          },
        })
      );
    });

    it("should use cached config for from email and name when not explicitly set", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      process.env.APP_NAME = "CachedApp";
      process.env.PRODUCTION_DOMAIN = "cached.com";
      // Explicitly clear SENDGRID_FROM_EMAIL and SENDGRID_FROM_NAME to test fallback
      delete process.env.SENDGRID_FROM_EMAIL;
      delete process.env.SENDGRID_FROM_NAME;

      vi.resetModules();
      const { sendEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      await sendEmail({
        to: "recipient@example.com",
        subject: "Test",
        text: "Test",
      });

      expect(mockSendGridSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: {
            email: "noreply@cached.com",
            name: "CachedApp",
          },
        })
      );
    });

    it("should throw error when SendGrid send fails", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";

      vi.resetModules();
      const { sendEmail } = await import("../../lib/email.js");

      const sendGridError = new Error("SendGrid API error");
      (sendGridError as any).response = { body: { errors: ["Invalid API key"] } };
      mockSendGridSend.mockRejectedValue(sendGridError);

      await expect(
        sendEmail({
          to: "recipient@example.com",
          subject: "Test",
          text: "Test",
        })
      ).rejects.toThrow("SendGrid API error");

      // Check that error logging happened
      expect(console.error).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Error sending email"),
        expect.any(Error)
      );
    });
  });

  describe("sendVerificationEmail", () => {
    it("should send verification email with template when configured", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      process.env.SENDGRID_VERIFICATION_TEMPLATE_ID = "d-verification123";
      process.env.APP_NAME = "TestApp";
      process.env.SUPPORT_EMAIL = "support@testapp.com";

      vi.resetModules();
      const { sendVerificationEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      await sendVerificationEmail(
        "user@example.com",
        "https://example.com/verify?token=abc123",
        "abc123"
      );

      expect(mockSendGridSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: "Verify your email address",
          templateId: "d-verification123",
          dynamicTemplateData: {
            verification_url: "https://example.com/verify?token=abc123",
            app_name: "TestApp",
            support_email: "support@testapp.com",
          },
        })
      );
    });

    it("should use template generator functions for HTML fallback", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      process.env.APP_NAME = "TestApp";
      // No SENDGRID_VERIFICATION_TEMPLATE_ID set

      vi.resetModules();
      const { sendVerificationEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      await sendVerificationEmail(
        "user@example.com",
        "https://example.com/verify?token=abc123",
        "abc123"
      );

      expect(mockSendGridSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: expect.stringContaining("Verify your email address"),
          text: expect.stringContaining("https://example.com/verify?token=abc123"),
          html: expect.stringContaining("https://example.com/verify?token=abc123"),
        })
      );

      // Verify HTML contains expected elements from template generator
      const htmlArg = mockSendGridSend.mock.calls[0][0].html;
      expect(htmlArg).toContain("Welcome to TestApp");
      expect(htmlArg).toContain("Verify Email");
      expect(htmlArg).toContain("This link will expire in 24 hours");
    });

    it("should include verification URL in both text and HTML", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";

      vi.resetModules();
      const { sendVerificationEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      const verificationUrl = "https://example.com/verify?token=xyz789";
      await sendVerificationEmail("user@example.com", verificationUrl, "xyz789");

      const { text, html } = mockSendGridSend.mock.calls[0][0];
      expect(text).toContain(verificationUrl);
      expect(html).toContain(verificationUrl);
    });

    it("should log when SendGrid is not configured", async () => {
      // No SENDGRID_API_KEY set
      vi.resetModules();
      const { sendVerificationEmail } = await import("../../lib/email.js");

      await sendVerificationEmail(
        "user@example.com",
        "https://example.com/verify",
        "token123"
      );

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Email would be sent")
      );
      expect(mockSendGridSend).not.toHaveBeenCalled();
    });
  });

  describe("sendPasswordResetEmail", () => {
    it("should send password reset email with template when configured", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      process.env.SENDGRID_RESET_TEMPLATE_ID = "d-reset123";
      process.env.APP_NAME = "TestApp";
      process.env.SUPPORT_EMAIL = "support@testapp.com";

      vi.resetModules();
      const { sendPasswordResetEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      await sendPasswordResetEmail(
        "user@example.com",
        "https://example.com/reset?token=reset123",
        "reset123"
      );

      expect(mockSendGridSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: "Reset your password",
          templateId: "d-reset123",
          dynamicTemplateData: {
            reset_url: "https://example.com/reset?token=reset123",
            app_name: "TestApp",
            support_email: "support@testapp.com",
          },
        })
      );
    });

    it("should use template generator functions for HTML fallback", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      process.env.APP_NAME = "TestApp";
      // No SENDGRID_RESET_TEMPLATE_ID set

      vi.resetModules();
      const { sendPasswordResetEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      await sendPasswordResetEmail(
        "user@example.com",
        "https://example.com/reset?token=reset123",
        "reset123"
      );

      expect(mockSendGridSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: expect.stringContaining("Reset your password"),
          text: expect.stringContaining("https://example.com/reset?token=reset123"),
          html: expect.stringContaining("https://example.com/reset?token=reset123"),
        })
      );

      // Verify HTML contains expected elements from template generator
      const htmlArg = mockSendGridSend.mock.calls[0][0].html;
      expect(htmlArg).toContain("Password Reset Request");
      expect(htmlArg).toContain("Reset Password");
      expect(htmlArg).toContain("This link will expire in 1 hour");
    });

    it("should include security warning in password reset email", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";

      vi.resetModules();
      const { sendPasswordResetEmail } = await import("../../lib/email.js");

      mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);

      await sendPasswordResetEmail(
        "user@example.com",
        "https://example.com/reset",
        "token"
      );

      const { text, html } = mockSendGridSend.mock.calls[0][0];
      expect(text).toContain("1 hour");
      expect(html).toContain("Important");
      expect(html).toContain("1 hour");
    });

    it("should log when SendGrid is not configured", async () => {
      vi.resetModules();
      const { sendPasswordResetEmail } = await import("../../lib/email.js");

      await sendPasswordResetEmail(
        "user@example.com",
        "https://example.com/reset",
        "token123"
      );

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Email would be sent")
      );
      expect(mockSendGridSend).not.toHaveBeenCalled();
    });
  });

  describe("Environment variables read once verification", () => {
    it("should not re-read environment variables on each function call", async () => {
      // Set initial values
      process.env.APP_NAME = "InitialApp";
      process.env.SUPPORT_EMAIL = "initial@app.com";
      process.env.SENDGRID_API_KEY = "test-key";

      vi.resetModules();
      const emailModule = await import("../../lib/email.js");

      // Store initial cached values
      const initialAppName = emailModule.EMAIL_CONFIG.appName;
      const initialSupportEmail = emailModule.EMAIL_CONFIG.supportEmail;

      expect(initialAppName).toBe("InitialApp");
      expect(initialSupportEmail).toBe("initial@app.com");

      // Change environment variables after module load
      process.env.APP_NAME = "ChangedApp";
      process.env.SUPPORT_EMAIL = "changed@app.com";

      // Config should still have initial values (cached at load time)
      expect(emailModule.EMAIL_CONFIG.appName).toBe("InitialApp");
      expect(emailModule.EMAIL_CONFIG.supportEmail).toBe("initial@app.com");

      // Template functions should also use cached values
      const html = emailModule.getVerificationEmailHtml("https://test.com");
      expect(html).toContain("Welcome to InitialApp");
      expect(html).toContain("initial@app.com");
      expect(html).not.toContain("ChangedApp");
      expect(html).not.toContain("changed@app.com");
    });

    it("should cache supportEmail with correct fallback logic", async () => {
      // Test that SUPPORT_EMAIL uses PRODUCTION_DOMAIN fallback when not set
      delete process.env.SUPPORT_EMAIL;
      process.env.PRODUCTION_DOMAIN = "custom-domain.io";

      vi.resetModules();
      const { EMAIL_CONFIG } = await import("../../lib/email.js");

      expect(EMAIL_CONFIG.supportEmail).toBe("support@custom-domain.io");
    });
  });
});
