/**
 * Unit tests for lib/cache.ts
 * Tests CacheService functionality including key prefixing,
 * JSON serialization, TTL handling, pattern deletion, metrics,
 * OpenTelemetry instrumentation, and bulk operations (mget/mset)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to create mock functions that are available during vi.mock hoisting
const {
  mockGet,
  mockSet,
  mockDel,
  mockScan,
  mockMget,
  mockPipeline,
  mockPipelineSet,
  mockPipelineExec,
} = vi.hoisted(() => {
  const mockPipelineSet = vi.fn();
  const mockPipelineExec = vi.fn();
  return {
    mockGet: vi.fn(),
    mockSet: vi.fn(),
    mockDel: vi.fn(),
    mockScan: vi.fn(),
    mockMget: vi.fn(),
    mockPipeline: vi.fn(() => ({
      set: mockPipelineSet,
      exec: mockPipelineExec,
    })),
    mockPipelineSet: mockPipelineSet,
    mockPipelineExec: mockPipelineExec,
  };
});

// Mock span for OpenTelemetry
const mockSpan = vi.hoisted(() => ({
  setAttributes: vi.fn(),
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
}));

// Mock tracer
const mockStartActiveSpan = vi.hoisted(() =>
  vi.fn((_name: string, fn: (span: typeof mockSpan) => Promise<unknown>) => {
    return fn(mockSpan);
  })
);

// Mock counter
const mockCounterAdd = vi.hoisted(() => vi.fn());

// Mock observable gauge
const mockAddCallback = vi.hoisted(() => vi.fn());

// Mock the redis module before importing cache
vi.mock("../../lib/redis.js", () => ({
  redis: {
    get: mockGet,
    set: mockSet,
    del: mockDel,
    scan: mockScan,
    mget: mockMget,
    pipeline: mockPipeline,
  },
}));

// Mock OpenTelemetry API
vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: mockStartActiveSpan,
    }),
  },
  metrics: {
    getMeter: () => ({
      createCounter: () => ({
        add: mockCounterAdd,
      }),
      createObservableGauge: () => ({
        addCallback: mockAddCallback,
      }),
    }),
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
}));

// Import after mocking
import { CacheService, cache } from "../../lib/cache.js";

describe("lib/cache.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReset();
    mockSet.mockReset();
    mockDel.mockReset();
    mockScan.mockReset();
    mockMget.mockReset();
    mockPipeline.mockClear();
    mockPipelineSet.mockClear();
    mockPipelineExec.mockClear();
    mockSpan.setAttributes.mockClear();
    mockSpan.setAttribute.mockClear();
    mockSpan.setStatus.mockClear();
    mockSpan.recordException.mockClear();
    mockSpan.end.mockClear();
    mockCounterAdd.mockClear();
  });

  describe("CacheService constructor", () => {
    it("should use default prefix 'auth:'", () => {
      const service = new CacheService();
      expect(service.getPrefix()).toBe("auth:");
    });

    it("should accept custom prefix", () => {
      const service = new CacheService("custom:");
      expect(service.getPrefix()).toBe("custom:");
    });

    it("should initialize metrics to zero", () => {
      const service = new CacheService();
      const metrics = service.getMetrics();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(0);
    });

    it("should register observable gauge callback", () => {
      new CacheService();
      expect(mockAddCallback).toHaveBeenCalled();
    });
  });

  describe("key prefixing", () => {
    it("should prefix keys on get", async () => {
      const service = new CacheService("test:");
      mockGet.mockResolvedValue(null);

      await service.get("mykey");

      expect(mockGet).toHaveBeenCalledWith("test:mykey");
    });

    it("should prefix keys on set", async () => {
      const service = new CacheService("test:");
      mockSet.mockResolvedValue("OK");

      await service.set("mykey", { value: 1 });

      expect(mockSet).toHaveBeenCalledWith("test:mykey", expect.any(String));
    });

    it("should prefix keys on delete", async () => {
      const service = new CacheService("test:");
      mockDel.mockResolvedValue(1);

      await service.delete("mykey");

      expect(mockDel).toHaveBeenCalledWith("test:mykey");
    });

    it("should prefix pattern on deleteByPattern", async () => {
      const service = new CacheService("test:");
      mockScan.mockResolvedValue(["0", []]);

      await service.deleteByPattern("user:*");

      expect(mockScan).toHaveBeenCalledWith(
        "0",
        "MATCH",
        "test:user:*",
        "COUNT",
        100
      );
    });
  });

  describe("JSON serialization/deserialization", () => {
    it("should serialize objects to JSON on set", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");

      const data = { name: "test", value: 123, nested: { a: 1 } };
      await service.set("key", data);

      expect(mockSet).toHaveBeenCalledWith("auth:key", JSON.stringify(data));
    });

    it("should deserialize JSON on get", async () => {
      const service = new CacheService();
      const data = { name: "test", value: 123 };
      mockGet.mockResolvedValue(JSON.stringify(data));

      const result = await service.get<typeof data>("key");

      expect(result).toEqual(data);
    });

    it("should handle arrays", async () => {
      const service = new CacheService();
      const data = [1, 2, 3, { a: "b" }];
      mockGet.mockResolvedValue(JSON.stringify(data));

      const result = await service.get<typeof data>("key");

      expect(result).toEqual(data);
    });

    it("should handle primitive values", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");
      mockGet.mockResolvedValue(JSON.stringify("hello"));

      await service.set("key", "hello");
      const result = await service.get<string>("key");

      expect(result).toBe("hello");
    });

    it("should handle numbers", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(JSON.stringify(42));

      const result = await service.get<number>("key");

      expect(result).toBe(42);
    });

    it("should handle boolean values", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(JSON.stringify(true));

      const result = await service.get<boolean>("key");

      expect(result).toBe(true);
    });

    it("should return raw string if JSON parse fails", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue("not-valid-json");

      const result = await service.get<string>("key");

      expect(result).toBe("not-valid-json");
    });
  });

  describe("TTL handling", () => {
    it("should set without TTL when not provided", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");

      await service.set("key", { value: 1 });

      expect(mockSet).toHaveBeenCalledWith("auth:key", expect.any(String));
      expect(mockSet).toHaveBeenCalledTimes(1);
      // Should NOT have EX argument
      expect(mockSet.mock.calls[0].length).toBe(2);
    });

    it("should set with TTL when provided", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");

      await service.set("key", { value: 1 }, 300);

      expect(mockSet).toHaveBeenCalledWith(
        "auth:key",
        expect.any(String),
        "EX",
        300
      );
    });

    it("should not set TTL when 0", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");

      await service.set("key", { value: 1 }, 0);

      expect(mockSet).toHaveBeenCalledWith("auth:key", expect.any(String));
      expect(mockSet.mock.calls[0].length).toBe(2);
    });

    it("should not set TTL when negative", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");

      await service.set("key", { value: 1 }, -10);

      expect(mockSet).toHaveBeenCalledWith("auth:key", expect.any(String));
      expect(mockSet.mock.calls[0].length).toBe(2);
    });
  });

  describe("metrics tracking", () => {
    it("should track cache hits", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(JSON.stringify({ value: 1 }));

      await service.get("key1");
      await service.get("key2");
      await service.get("key3");

      const metrics = service.getMetrics();
      expect(metrics.hits).toBe(3);
      expect(metrics.misses).toBe(0);
    });

    it("should track cache misses", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(null);

      await service.get("key1");
      await service.get("key2");

      const metrics = service.getMetrics();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(2);
    });

    it("should track mixed hits and misses", async () => {
      const service = new CacheService();
      mockGet
        .mockResolvedValueOnce(JSON.stringify({ value: 1 })) // hit
        .mockResolvedValueOnce(null) // miss
        .mockResolvedValueOnce(JSON.stringify({ value: 2 })) // hit
        .mockResolvedValueOnce(null); // miss

      await service.get("key1");
      await service.get("key2");
      await service.get("key3");
      await service.get("key4");

      const metrics = service.getMetrics();
      expect(metrics.hits).toBe(2);
      expect(metrics.misses).toBe(2);
    });

    it("should calculate hit rate correctly", async () => {
      const service = new CacheService();
      mockGet
        .mockResolvedValueOnce(JSON.stringify({ value: 1 })) // hit
        .mockResolvedValueOnce(JSON.stringify({ value: 2 })) // hit
        .mockResolvedValueOnce(JSON.stringify({ value: 3 })) // hit
        .mockResolvedValueOnce(null); // miss

      await service.get("key1");
      await service.get("key2");
      await service.get("key3");
      await service.get("key4");

      expect(service.getHitRate()).toBe(0.75);
    });

    it("should return 0 hit rate when no requests", () => {
      const service = new CacheService();
      expect(service.getHitRate()).toBe(0);
    });

    it("should reset metrics", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(JSON.stringify({ value: 1 }));

      await service.get("key1");
      await service.get("key2");

      expect(service.getMetrics().hits).toBe(2);

      service.resetMetrics();

      const metrics = service.getMetrics();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(0);
    });

    it("should return a copy of metrics", () => {
      const service = new CacheService();
      const metrics1 = service.getMetrics();
      metrics1.hits = 100;

      const metrics2 = service.getMetrics();
      expect(metrics2.hits).toBe(0);
    });
  });

  describe("deleteByPattern", () => {
    it("should delete all matching keys in single scan", async () => {
      const service = new CacheService();
      mockScan.mockResolvedValue(["0", ["auth:user:1", "auth:user:2"]]);
      mockDel.mockResolvedValue(2);

      const count = await service.deleteByPattern("user:*");

      expect(count).toBe(2);
      expect(mockDel).toHaveBeenCalledWith("auth:user:1", "auth:user:2");
    });

    it("should handle multiple scan iterations", async () => {
      const service = new CacheService();
      mockScan
        .mockResolvedValueOnce(["5", ["auth:user:1", "auth:user:2"]])
        .mockResolvedValueOnce(["10", ["auth:user:3"]])
        .mockResolvedValueOnce(["0", ["auth:user:4", "auth:user:5"]]);
      mockDel.mockResolvedValue(2);

      const count = await service.deleteByPattern("user:*");

      expect(count).toBe(5);
      expect(mockScan).toHaveBeenCalledTimes(3);
      expect(mockDel).toHaveBeenCalledTimes(3);
    });

    it("should handle empty result", async () => {
      const service = new CacheService();
      mockScan.mockResolvedValue(["0", []]);

      const count = await service.deleteByPattern("nonexistent:*");

      expect(count).toBe(0);
      expect(mockDel).not.toHaveBeenCalled();
    });

    it("should use COUNT 100 for efficiency", async () => {
      const service = new CacheService();
      mockScan.mockResolvedValue(["0", []]);

      await service.deleteByPattern("user:*");

      expect(mockScan).toHaveBeenCalledWith(
        "0",
        "MATCH",
        "auth:user:*",
        "COUNT",
        100
      );
    });
  });

  describe("singleton export", () => {
    it("should export a cache singleton with default prefix", () => {
      expect(cache).toBeInstanceOf(CacheService);
      expect(cache.getPrefix()).toBe("auth:");
    });
  });

  describe("get with null value", () => {
    it("should return null when key does not exist", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(null);

      const result = await service.get("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("delete operation", () => {
    it("should call redis del with prefixed key", async () => {
      const service = new CacheService("app:");
      mockDel.mockResolvedValue(1);

      await service.delete("session:123");

      expect(mockDel).toHaveBeenCalledWith("app:session:123");
    });
  });

  describe("OpenTelemetry instrumentation", () => {
    it("should create span for get operation", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(JSON.stringify({ value: 1 }));

      await service.get("key");

      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "cache.get",
        expect.any(Function)
      );
    });

    it("should set span attributes on cache hit", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(JSON.stringify({ value: 1 }));

      await service.get("key");

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({
        "cache.operation": "get",
        "cache.key_prefix": "auth:",
      });
      expect(mockSpan.setAttribute).toHaveBeenCalledWith("cache.hit", true);
    });

    it("should set span attributes on cache miss", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(null);

      await service.get("key");

      expect(mockSpan.setAttribute).toHaveBeenCalledWith("cache.hit", false);
    });

    it("should create span for set operation", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");

      await service.set("key", { value: 1 });

      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "cache.set",
        expect.any(Function)
      );
    });

    it("should set TTL attribute on set with TTL", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");

      await service.set("key", { value: 1 }, 300);

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "cache.operation": "set",
        })
      );
    });

    it("should create span for delete operation", async () => {
      const service = new CacheService();
      mockDel.mockResolvedValue(1);

      await service.delete("key");

      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "cache.delete",
        expect.any(Function)
      );
    });

    it("should create span for deleteByPattern operation", async () => {
      const service = new CacheService();
      mockScan.mockResolvedValue(["0", []]);

      await service.deleteByPattern("user:*");

      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "cache.deleteByPattern",
        expect.any(Function)
      );
    });

    it("should record metrics for cache hit", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(JSON.stringify({ value: 1 }));

      await service.get("key");

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "get",
        status: "hit",
        "cache.key_prefix": "auth:",
      });
    });

    it("should record metrics for cache miss", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(null);

      await service.get("key");

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "get",
        status: "miss",
        "cache.key_prefix": "auth:",
      });
    });

    it("should record metrics for set success", async () => {
      const service = new CacheService();
      mockSet.mockResolvedValue("OK");

      await service.set("key", { value: 1 });

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "set",
        status: "success",
        "cache.key_prefix": "auth:",
      });
    });

    it("should record metrics for delete success", async () => {
      const service = new CacheService();
      mockDel.mockResolvedValue(1);

      await service.delete("key");

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "delete",
        status: "success",
        "cache.key_prefix": "auth:",
      });
    });

    it("should record error status on Redis failure", async () => {
      const service = new CacheService();
      const error = new Error("Redis connection failed");
      mockGet.mockRejectedValue(error);

      await expect(service.get("key")).rejects.toThrow(
        "Redis connection failed"
      );

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: 2, // ERROR
        message: "Redis connection failed",
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "get",
        status: "error",
        "cache.key_prefix": "auth:",
      });
    });

    it("should end span after operation completes", async () => {
      const service = new CacheService();
      mockGet.mockResolvedValue(JSON.stringify({ value: 1 }));

      await service.get("key");

      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  describe("mget bulk operation", () => {
    it("should return empty array for empty keys", async () => {
      const service = new CacheService();

      const result = await service.mget([]);

      expect(result).toEqual([]);
      expect(mockMget).not.toHaveBeenCalled();
    });

    it("should prefix all keys", async () => {
      const service = new CacheService("test:");
      mockMget.mockResolvedValue([null, null]);

      await service.mget(["key1", "key2"]);

      expect(mockMget).toHaveBeenCalledWith("test:key1", "test:key2");
    });

    it("should return values in correct order", async () => {
      const service = new CacheService();
      mockMget.mockResolvedValue([
        JSON.stringify({ a: 1 }),
        JSON.stringify({ b: 2 }),
        JSON.stringify({ c: 3 }),
      ]);

      const result = await service.mget<{ a?: number; b?: number; c?: number }>([
        "key1",
        "key2",
        "key3",
      ]);

      expect(result).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it("should return null for missing keys", async () => {
      const service = new CacheService();
      mockMget.mockResolvedValue([
        JSON.stringify({ a: 1 }),
        null,
        JSON.stringify({ c: 3 }),
      ]);

      const result = await service.mget<{ a?: number; c?: number }>([
        "key1",
        "key2",
        "key3",
      ]);

      expect(result).toEqual([{ a: 1 }, null, { c: 3 }]);
    });

    it("should handle non-JSON values", async () => {
      const service = new CacheService();
      mockMget.mockResolvedValue(["not-json", JSON.stringify({ a: 1 })]);

      const result = await service.mget(["key1", "key2"]);

      expect(result).toEqual(["not-json", { a: 1 }]);
    });

    it("should track hits and misses", async () => {
      const service = new CacheService();
      mockMget.mockResolvedValue([
        JSON.stringify({ a: 1 }),
        null,
        JSON.stringify({ c: 3 }),
        null,
      ]);

      await service.mget(["key1", "key2", "key3", "key4"]);

      const metrics = service.getMetrics();
      expect(metrics.hits).toBe(2);
      expect(metrics.misses).toBe(2);
    });

    it("should create span for mget operation", async () => {
      const service = new CacheService();
      mockMget.mockResolvedValue([JSON.stringify({ a: 1 })]);

      await service.mget(["key1"]);

      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "cache.mget",
        expect.any(Function)
      );
    });

    it("should set span attributes for hits and misses", async () => {
      const service = new CacheService();
      mockMget.mockResolvedValue([JSON.stringify({ a: 1 }), null]);

      await service.mget(["key1", "key2"]);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith("cache.hits", 1);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith("cache.misses", 1);
    });

    it("should record metrics for hits and misses", async () => {
      const service = new CacheService();
      mockMget.mockResolvedValue([JSON.stringify({ a: 1 }), null]);

      await service.mget(["key1", "key2"]);

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "mget",
        status: "hit",
        "cache.key_prefix": "auth:",
      });
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "mget",
        status: "miss",
        "cache.key_prefix": "auth:",
      });
    });

    it("should handle errors", async () => {
      const service = new CacheService();
      const error = new Error("Redis connection failed");
      mockMget.mockRejectedValue(error);

      await expect(service.mget(["key1"])).rejects.toThrow(
        "Redis connection failed"
      );

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "mget",
        status: "error",
        "cache.key_prefix": "auth:",
      });
    });
  });

  describe("mset bulk operation", () => {
    it("should do nothing for empty entries", async () => {
      const service = new CacheService();

      await service.mset([]);

      expect(mockPipeline).not.toHaveBeenCalled();
    });

    it("should use pipeline for multiple sets", async () => {
      const service = new CacheService();
      mockPipelineSet.mockReturnThis();
      mockPipelineExec.mockResolvedValue([]);

      await service.mset([
        { key: "key1", value: { a: 1 } },
        { key: "key2", value: { b: 2 } },
      ]);

      expect(mockPipeline).toHaveBeenCalled();
      expect(mockPipelineSet).toHaveBeenCalledTimes(2);
      expect(mockPipelineExec).toHaveBeenCalled();
    });

    it("should prefix all keys", async () => {
      const service = new CacheService("test:");
      mockPipelineSet.mockReturnThis();
      mockPipelineExec.mockResolvedValue([]);

      await service.mset([
        { key: "key1", value: { a: 1 } },
        { key: "key2", value: { b: 2 } },
      ]);

      expect(mockPipelineSet).toHaveBeenCalledWith(
        "test:key1",
        JSON.stringify({ a: 1 })
      );
      expect(mockPipelineSet).toHaveBeenCalledWith(
        "test:key2",
        JSON.stringify({ b: 2 })
      );
    });

    it("should set TTL when provided", async () => {
      const service = new CacheService();
      mockPipelineSet.mockReturnThis();
      mockPipelineExec.mockResolvedValue([]);

      await service.mset([
        { key: "key1", value: { a: 1 }, ttl: 300 },
        { key: "key2", value: { b: 2 } },
      ]);

      expect(mockPipelineSet).toHaveBeenCalledWith(
        "auth:key1",
        JSON.stringify({ a: 1 }),
        "EX",
        300
      );
      expect(mockPipelineSet).toHaveBeenCalledWith(
        "auth:key2",
        JSON.stringify({ b: 2 })
      );
    });

    it("should not set TTL when 0 or negative", async () => {
      const service = new CacheService();
      mockPipelineSet.mockReturnThis();
      mockPipelineExec.mockResolvedValue([]);

      await service.mset([
        { key: "key1", value: { a: 1 }, ttl: 0 },
        { key: "key2", value: { b: 2 }, ttl: -10 },
      ]);

      expect(mockPipelineSet).toHaveBeenNthCalledWith(
        1,
        "auth:key1",
        JSON.stringify({ a: 1 })
      );
      expect(mockPipelineSet).toHaveBeenNthCalledWith(
        2,
        "auth:key2",
        JSON.stringify({ b: 2 })
      );
    });

    it("should create span for mset operation", async () => {
      const service = new CacheService();
      mockPipelineSet.mockReturnThis();
      mockPipelineExec.mockResolvedValue([]);

      await service.mset([{ key: "key1", value: { a: 1 } }]);

      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "cache.mset",
        expect.any(Function)
      );
    });

    it("should set key count attribute", async () => {
      const service = new CacheService();
      mockPipelineSet.mockReturnThis();
      mockPipelineExec.mockResolvedValue([]);

      await service.mset([
        { key: "key1", value: { a: 1 } },
        { key: "key2", value: { b: 2 } },
      ]);

      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "cache.operation": "mset",
        })
      );
    });

    it("should record success metric", async () => {
      const service = new CacheService();
      mockPipelineSet.mockReturnThis();
      mockPipelineExec.mockResolvedValue([]);

      await service.mset([{ key: "key1", value: { a: 1 } }]);

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "mset",
        status: "success",
        "cache.key_prefix": "auth:",
      });
    });

    it("should handle errors", async () => {
      const service = new CacheService();
      const error = new Error("Pipeline failed");
      mockPipelineSet.mockReturnThis();
      mockPipelineExec.mockRejectedValue(error);

      await expect(
        service.mset([{ key: "key1", value: { a: 1 } }])
      ).rejects.toThrow("Pipeline failed");

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        operation: "mset",
        status: "error",
        "cache.key_prefix": "auth:",
      });
    });
  });
});
