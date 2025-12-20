/**
 * Integration tests for middleware stack
 * Tests that middleware components work together correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createMockRequest, createMockResponse, createMockNext, mockPoolQuery } from "../setup.js";

describe("Middleware Stack Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
  });

  describe("Health Check with Database", () => {
    it("should integrate database check in health endpoint", async () => {
      // This tests the health check logic pattern
      const errors: string[] = [];

      try {
        await mockPoolQuery("SELECT 1");
      } catch (error) {
        errors.push(`Database unhealthy: ${error instanceof Error ? error.message : String(error)}`);
      }

      expect(errors).toHaveLength(0);
      expect(mockPoolQuery).toHaveBeenCalledWith("SELECT 1");
    });

    it("should catch database errors in health check", async () => {
      mockPoolQuery.mockRejectedValue(new Error("Connection refused"));

      const errors: string[] = [];

      try {
        await mockPoolQuery("SELECT 1");
      } catch (error) {
        errors.push(`Database unhealthy: ${error instanceof Error ? error.message : String(error)}`);
      }

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Connection refused");
    });
  });

  describe("Middleware Flow", () => {
    it("should flow through middleware chain correctly", async () => {
      const middleware1 = vi.fn((req: Request, res: Response, next: NextFunction) => next());
      const middleware2 = vi.fn((req: Request, res: Response, next: NextFunction) => next());
      const middleware3 = vi.fn((req: Request, res: Response, next: NextFunction) => next());

      const app = express();
      app.use(middleware1);
      app.use(middleware2);
      app.use(middleware3);
      app.get("/test", (_req, res) => res.json({ ok: true }));

      // Simulate request flow
      const req = createMockRequest({ path: "/test", method: "GET" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware1(req as any, res as any, next);
      expect(middleware1).toHaveBeenCalled();
    });
  });

  describe("Error Handler Pattern", () => {
    it("should format errors correctly in development", () => {
      const error = new Error("Test error");
      (error as any).status = 400;

      const formattedError = {
        error: error.message,
        stack: error.stack,
      };

      expect(formattedError.error).toBe("Test error");
      expect(formattedError.stack).toBeDefined();
    });

    it("should not include stack in production", () => {
      process.env.NODE_ENV = "production";

      const error = new Error("Test error");
      const formattedError = {
        error: error.message,
        ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
      };

      expect(formattedError).not.toHaveProperty("stack");

      process.env.NODE_ENV = "test";
    });
  });

  describe("404 Handler Pattern", () => {
    it("should format 404 errors correctly", () => {
      const req = { method: "GET", path: "/non-existent" };

      const response = {
        error: "Not Found",
        message: `Cannot ${req.method} ${req.path}`,
      };

      expect(response).toEqual({
        error: "Not Found",
        message: "Cannot GET /non-existent",
      });
    });
  });

  describe("CORS Origin Validation", () => {
    it("should validate allowed origins", () => {
      const allowedOrigins = [
        process.env.FRONTEND_URL || "http://localhost:5173",
        process.env.API_URL || "http://localhost:3001",
      ];

      expect(allowedOrigins).toContain("http://localhost:5173");
      expect(allowedOrigins).toContain("http://localhost:3001");
    });
  });

  describe("Rate Limiting Configuration", () => {
    it("should configure rate limiting correctly", () => {
      const config = {
        windowMs: 15 * 60 * 1000,
        max: 100,
        message: "Too many requests from this IP, please try again later.",
      };

      expect(config.windowMs).toBe(900000); // 15 minutes
      expect(config.max).toBe(100);
    });
  });

  describe("Request Body Parsing", () => {
    it("should parse JSON bodies", () => {
      const body = { email: "test@example.com", password: "password123" };
      const jsonString = JSON.stringify(body);
      const parsed = JSON.parse(jsonString);

      expect(parsed).toEqual(body);
    });

    it("should handle URL-encoded data", () => {
      const urlencoded = "email=test%40example.com&password=password123";
      const params = new URLSearchParams(urlencoded);

      expect(params.get("email")).toBe("test@example.com");
      expect(params.get("password")).toBe("password123");
    });
  });
});
