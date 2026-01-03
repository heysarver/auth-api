/**
 * Unit tests for lib/redis.ts
 * Tests Redis/ValKey client initialization, event handlers, logger injection,
 * and explicit cleanup handlers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockRedisOn, mockRedisQuit } from "../setup.js";

describe("lib/redis.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.REDIS_URL;
    delete process.env.VALKEY_SENTINEL_HOST;
  });

  afterEach(async () => {
    // Clean up module state between tests
    vi.resetModules();
  });

  describe("Redis initialization", () => {
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

      expect(console.warn).toHaveBeenCalledWith(
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

  describe("Logger injection", () => {
    it("should use default console logger initially", async () => {
      vi.resetModules();
      const { getLogger } = await import("../../lib/redis.js");

      const logger = getLogger();
      expect(logger).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.debug).toBeDefined();
    });

    it("should allow setting a custom logger", async () => {
      vi.resetModules();
      const { setLogger, getLogger } = await import("../../lib/redis.js");

      const customLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };

      setLogger(customLogger);
      const logger = getLogger();

      expect(logger).toBe(customLogger);
    });

    it("should reset logger to default", async () => {
      vi.resetModules();
      const { setLogger, resetLogger, getLogger } = await import("../../lib/redis.js");

      const customLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };

      setLogger(customLogger);
      expect(getLogger()).toBe(customLogger);

      resetLogger();
      const logger = getLogger();

      // Should be back to default (not the custom one)
      expect(logger).not.toBe(customLogger);
      expect(logger.info).toBeDefined();
    });

    it("should use custom logger for connection events", async () => {
      vi.resetModules();
      const { setLogger } = await import("../../lib/redis.js");

      const customLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };

      setLogger(customLogger);

      // Trigger the connect handler
      const connectHandler = mockRedisOn.mock.calls.find(
        (call) => call[0] === "connect"
      )?.[1];

      connectHandler?.();

      expect(customLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Redis connected")
      );
    });

    it("should use custom logger for error events", async () => {
      vi.resetModules();
      const { setLogger } = await import("../../lib/redis.js");

      const customLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };

      setLogger(customLogger);

      // Trigger the error handler
      const errorHandler = mockRedisOn.mock.calls.find(
        (call) => call[0] === "error"
      )?.[1];

      const testError = new Error("Test error");
      errorHandler?.(testError);

      expect(customLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Redis connection error"),
        testError
      );
    });

    it("should use custom logger for close events", async () => {
      vi.resetModules();
      const { setLogger } = await import("../../lib/redis.js");

      const customLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };

      setLogger(customLogger);

      // Trigger the close handler
      const closeHandler = mockRedisOn.mock.calls.find(
        (call) => call[0] === "close"
      )?.[1];

      closeHandler?.();

      expect(customLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Redis connection closed")
      );
    });
  });

  describe("Explicit cleanup handlers", () => {
    it("should not register cleanup handlers automatically on import", async () => {
      vi.resetModules();

      const processOnSpy = vi.spyOn(process, "on");

      await import("../../lib/redis.js");

      // Check that SIGINT and SIGTERM handlers were NOT registered on import
      const sigintCalls = processOnSpy.mock.calls.filter(
        (call) => call[0] === "SIGINT"
      );
      const sigtermCalls = processOnSpy.mock.calls.filter(
        (call) => call[0] === "SIGTERM"
      );

      expect(sigintCalls.length).toBe(0);
      expect(sigtermCalls.length).toBe(0);

      processOnSpy.mockRestore();
    });

    it("should register cleanup handlers when registerCleanupHandlers is called", async () => {
      vi.resetModules();

      const processOnSpy = vi.spyOn(process, "on");

      const { registerCleanupHandlers, unregisterCleanupHandlers } = await import("../../lib/redis.js");

      registerCleanupHandlers();

      // Check that SIGINT and SIGTERM handlers were registered
      const sigintCalls = processOnSpy.mock.calls.filter(
        (call) => call[0] === "SIGINT"
      );
      const sigtermCalls = processOnSpy.mock.calls.filter(
        (call) => call[0] === "SIGTERM"
      );

      expect(sigintCalls.length).toBe(1);
      expect(sigtermCalls.length).toBe(1);

      // Cleanup
      unregisterCleanupHandlers();
      processOnSpy.mockRestore();
    });

    it("should be idempotent - multiple calls should not register duplicate handlers", async () => {
      vi.resetModules();

      const processOnSpy = vi.spyOn(process, "on");

      const { registerCleanupHandlers, unregisterCleanupHandlers } = await import("../../lib/redis.js");

      registerCleanupHandlers();
      registerCleanupHandlers();
      registerCleanupHandlers();

      // Should only have one handler for each signal
      const sigintCalls = processOnSpy.mock.calls.filter(
        (call) => call[0] === "SIGINT"
      );
      const sigtermCalls = processOnSpy.mock.calls.filter(
        (call) => call[0] === "SIGTERM"
      );

      expect(sigintCalls.length).toBe(1);
      expect(sigtermCalls.length).toBe(1);

      // Cleanup
      unregisterCleanupHandlers();
      processOnSpy.mockRestore();
    });

    it("should track cleanup handler registration state", async () => {
      vi.resetModules();

      const {
        registerCleanupHandlers,
        unregisterCleanupHandlers,
        areCleanupHandlersRegistered
      } = await import("../../lib/redis.js");

      expect(areCleanupHandlersRegistered()).toBe(false);

      registerCleanupHandlers();
      expect(areCleanupHandlersRegistered()).toBe(true);

      unregisterCleanupHandlers();
      expect(areCleanupHandlersRegistered()).toBe(false);
    });

    it("should unregister cleanup handlers", async () => {
      vi.resetModules();

      const processRemoveListenerSpy = vi.spyOn(process, "removeListener");

      const { registerCleanupHandlers, unregisterCleanupHandlers } = await import("../../lib/redis.js");

      registerCleanupHandlers();
      unregisterCleanupHandlers();

      expect(processRemoveListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
      expect(processRemoveListenerSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

      processRemoveListenerSpy.mockRestore();
    });

    it("should call disconnect on SIGINT when handlers are registered", async () => {
      vi.resetModules();

      const processOnSpy = vi.spyOn(process, "on");
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const { registerCleanupHandlers, unregisterCleanupHandlers } = await import("../../lib/redis.js");

      registerCleanupHandlers();

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

      // Cleanup
      unregisterCleanupHandlers();
      processOnSpy.mockRestore();
      processExitSpy.mockRestore();
    });

    it("should call disconnect on SIGTERM when handlers are registered", async () => {
      vi.resetModules();

      const processOnSpy = vi.spyOn(process, "on");
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });

      const { registerCleanupHandlers, unregisterCleanupHandlers } = await import("../../lib/redis.js");

      registerCleanupHandlers();

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

      // Cleanup
      unregisterCleanupHandlers();
      processOnSpy.mockRestore();
      processExitSpy.mockRestore();
    });
  });

  describe("Explicit disconnect function", () => {
    it("should export disconnect function", async () => {
      vi.resetModules();
      const { disconnect } = await import("../../lib/redis.js");

      expect(disconnect).toBeDefined();
      expect(typeof disconnect).toBe("function");
    });

    it("should call redis.quit when disconnect is called", async () => {
      vi.resetModules();
      const { disconnect } = await import("../../lib/redis.js");

      await disconnect();

      expect(mockRedisQuit).toHaveBeenCalled();
    });

    it("should log disconnect messages", async () => {
      vi.resetModules();
      const { disconnect } = await import("../../lib/redis.js");

      await disconnect();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Disconnecting Redis client")
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Redis client disconnected")
      );
    });
  });

  describe("RedisLogger interface export", () => {
    it("should export RedisLogger type", async () => {
      vi.resetModules();
      // This test verifies the type is exported by importing it
      // If the type doesn't exist, TypeScript compilation will fail
      const module = await import("../../lib/redis.js");

      // Verify the logger-related functions exist
      expect(module.setLogger).toBeDefined();
      expect(module.getLogger).toBeDefined();
      expect(module.resetLogger).toBeDefined();
    });
  });
});
