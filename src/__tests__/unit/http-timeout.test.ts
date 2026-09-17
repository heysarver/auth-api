/**
 * Unit tests for lib/http-timeout.ts
 * Verifies fetch timeout option construction and default timeout.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchTimeoutOptions, DEFAULT_OUTBOUND_TIMEOUT_MS } =
  await import("../../lib/http-timeout.js");

describe("lib/http-timeout.ts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("fetchTimeoutOptions", () => {
    it("adds an AbortSignal timeout to options", () => {
      const opts = fetchTimeoutOptions({ method: "POST" });
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.method).toBe("POST");
    });

    it("preserves caller-provided headers and body", () => {
      const headers = { "Content-Type": "application/json" };
      const body = JSON.stringify({ a: 1 });
      const opts = fetchTimeoutOptions({ method: "POST", headers, body });
      expect(opts.headers).toBe(headers);
      expect(opts.body).toBe(body);
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it("overwrites a caller-provided signal with the timeout signal", () => {
      const callerSignal = AbortSignal.timeout(1);
      const opts = fetchTimeoutOptions({ signal: callerSignal });
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.signal).not.toBe(callerSignal);
    });

    it("uses the provided timeout value", () => {
      const opts = fetchTimeoutOptions({}, 5000);
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("DEFAULT_OUTBOUND_TIMEOUT_MS", () => {
    it("is a positive number (10s default)", () => {
      expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBeGreaterThan(0);
      expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(10_000);
    });
  });
});
