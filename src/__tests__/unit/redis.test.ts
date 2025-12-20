/**
 * Unit tests for lib/redis.ts
 * Tests Redis/ValKey client initialization and event handlers
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRedisOn, mockRedisQuit } from "../setup.js";

describe("lib/redis.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.REDIS_URL;
  });

  it("should initialize Redis with default URL", async () => {
    vi.resetModules();
    const Redis = (await import("ioredis")).default;

    await import("../../lib/redis.js");

    expect(Redis).toHaveBeenCalledWith(
      "redis://localhost:6379/1",
      expect.objectContaining({
        maxRetriesPerRequest: 3,
        retryStrategy: expect.any(Function),
        reconnectOnError: expect.any(Function),
      })
    );
  });

  it("should initialize Redis with custom URL from environment", async () => {
    process.env.REDIS_URL = "redis://custom-host:6380/5";

    vi.resetModules();
    const Redis = (await import("ioredis")).default;

    await import("../../lib/redis.js");

    expect(Redis).toHaveBeenCalledWith(
      "redis://custom-host:6380/5",
      expect.any(Object)
    );
  });

  it("should register event handlers", async () => {
    vi.resetModules();
    await import("../../lib/redis.js");

    // Should register connect, error, and close handlers
    expect(mockRedisOn).toHaveBeenCalledWith("connect", expect.any(Function));
    expect(mockRedisOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(mockRedisOn).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("should log on successful connection", async () => {
    vi.resetModules();
    await import("../../lib/redis.js");

    // Get the connect handler
    const connectHandler = mockRedisOn.mock.calls.find(
      (call) => call[0] === "connect"
    )?.[1];

    expect(connectHandler).toBeDefined();
    connectHandler?.();

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Redis connected")
    );
  });

  it("should log errors on connection error", async () => {
    vi.resetModules();
    await import("../../lib/redis.js");

    // Get the error handler
    const errorHandler = mockRedisOn.mock.calls.find(
      (call) => call[0] === "error"
    )?.[1];

    expect(errorHandler).toBeDefined();
    const testError = new Error("Connection failed");
    errorHandler?.(testError);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Redis connection error"),
      testError
    );
  });

  it("should log on connection close", async () => {
    vi.resetModules();
    await import("../../lib/redis.js");

    // Get the close handler
    const closeHandler = mockRedisOn.mock.calls.find(
      (call) => call[0] === "close"
    )?.[1];

    expect(closeHandler).toBeDefined();
    closeHandler?.();

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Redis connection closed")
    );
  });

  it("should have retry strategy that increases delay", async () => {
    vi.resetModules();
    const Redis = (await import("ioredis")).default;

    await import("../../lib/redis.js");

    const config = (Redis as any).mock.calls[0][1];
    const retryStrategy = config.retryStrategy;

    // Test retry delays
    expect(retryStrategy(1)).toBe(50); // First retry: 50ms
    expect(retryStrategy(2)).toBe(100); // Second retry: 100ms
    expect(retryStrategy(10)).toBe(500); // Tenth retry: 500ms
    expect(retryStrategy(50)).toBe(2000); // Max delay: 2000ms
  });

  it("should have reconnectOnError strategy for READONLY errors", async () => {
    vi.resetModules();
    const Redis = (await import("ioredis")).default;

    await import("../../lib/redis.js");

    const config = (Redis as any).mock.calls[0][1];
    const reconnectOnError = config.reconnectOnError;

    // Should reconnect for READONLY errors
    const readonlyError = new Error("READONLY You can't write against a read only replica.");
    expect(reconnectOnError(readonlyError)).toBe(true);

    // Should not reconnect for other errors
    const otherError = new Error("Some other error");
    expect(reconnectOnError(otherError)).toBe(false);
  });

  it("should quit Redis on SIGINT", async () => {
    vi.resetModules();

    // Mock process.on
    const processOnSpy = vi.spyOn(process, "on");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await import("../../lib/redis.js");

    // Find SIGINT handler
    const sigintHandler = processOnSpy.mock.calls.find(
      (call) => call[0] === "SIGINT"
    )?.[1];

    expect(sigintHandler).toBeDefined();

    // Execute handler
    try {
      await (sigintHandler as any)();
    } catch (error: any) {
      expect(error.message).toBe("process.exit called");
    }

    expect(mockRedisQuit).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);

    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("should quit Redis on SIGTERM", async () => {
    vi.resetModules();

    const processOnSpy = vi.spyOn(process, "on");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await import("../../lib/redis.js");

    // Find SIGTERM handler
    const sigtermHandler = processOnSpy.mock.calls.find(
      (call) => call[0] === "SIGTERM"
    )?.[1];

    expect(sigtermHandler).toBeDefined();

    // Execute handler
    try {
      await (sigtermHandler as any)();
    } catch (error: any) {
      expect(error.message).toBe("process.exit called");
    }

    expect(mockRedisQuit).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);

    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("should export redis client instance", async () => {
    vi.resetModules();
    const { redis } = await import("../../lib/redis.js");

    expect(redis).toBeDefined();
    expect(redis.get).toBeDefined();
    expect(redis.set).toBeDefined();
    expect(redis.del).toBeDefined();
    expect(redis.quit).toBeDefined();
  });

  it("should configure maxRetriesPerRequest to 3", async () => {
    vi.resetModules();
    const Redis = (await import("ioredis")).default;

    await import("../../lib/redis.js");

    const config = (Redis as any).mock.calls[0][1];
    expect(config.maxRetriesPerRequest).toBe(3);
  });
});
