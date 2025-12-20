/**
 * Unit tests for lib/email.ts
 * Tests SendGrid email sending functionality with various configurations
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

    it("should use default from email and name when not configured", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      // Use existing APP_NAME and PRODUCTION_DOMAIN from setup

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
            email: expect.any(String),
            name: expect.any(String),
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

    it("should send verification email with HTML fallback when no template", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      process.env.APP_NAME = "TestApp";

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

      // Verify HTML contains expected elements
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

    it("should send password reset email with HTML fallback when no template", async () => {
      process.env.SENDGRID_API_KEY = "test-api-key";
      process.env.APP_NAME = "TestApp";

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

      // Verify HTML contains expected elements
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
      expect(html).toContain("⚠️ Important");
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
});
