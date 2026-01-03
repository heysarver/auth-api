/**
 * Cache wrapper library for Redis/ValKey
 * Provides typed caching with key prefixing, JSON serialization, and metrics
 *
 * Features:
 * - Automatic key prefixing
 * - JSON serialization/deserialization
 * - TTL support
 * - Pattern-based deletion using SCAN
 * - Hit/miss metrics tracking
 * - OpenTelemetry instrumentation (spans and metrics)
 * - Bulk operations (MGET/MSET)
 */

import { trace, metrics, SpanStatusCode, Span } from "@opentelemetry/api";
import { redis } from "./redis.js";

// OpenTelemetry tracer and meter
const tracer = trace.getTracer("auth-api", "1.0.0");
const meter = metrics.getMeter("auth-api", "1.0.0");

// OpenTelemetry metrics
const cacheOperationsCounter = meter.createCounter("cache_operations_total", {
  description: "Total number of cache operations",
  unit: "{operation}",
});

const cacheHitRateGauge = meter.createObservableGauge("cache_hit_rate", {
  description: "Cache hit rate as a ratio (0-1)",
  unit: "1",
});

/**
 * Cache metrics for monitoring hit rates
 */
interface CacheMetrics {
  hits: number;
  misses: number;
}

/**
 * Entry for bulk set operations
 */
interface MSetEntry<T> {
  key: string;
  value: T;
  ttl?: number;
}

/**
 * CacheService provides a high-level caching API with:
 * - Automatic key prefixing
 * - JSON serialization/deserialization
 * - TTL support
 * - Pattern-based deletion using SCAN
 * - Hit/miss metrics tracking
 * - OpenTelemetry instrumentation
 * - Bulk operations (mget/mset)
 */
export class CacheService {
  private readonly prefix: string;
  private metrics: CacheMetrics;

  /**
   * Create a new CacheService instance
   * @param prefix - Key prefix for all cache operations (default: "auth:")
   */
  constructor(prefix: string = "auth:") {
    this.prefix = prefix;
    this.metrics = {
      hits: 0,
      misses: 0,
    };

    // Register observable gauge callback for hit rate
    cacheHitRateGauge.addCallback((result) => {
      result.observe(this.getHitRate(), {
        "cache.key_prefix": this.prefix,
      });
    });
  }

  /**
   * Build the full cache key with prefix
   */
  private buildKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Add common span attributes
   */
  private addSpanAttributes(
    span: Span,
    operation: string,
    options: {
      hit?: boolean;
      ttlSeconds?: number;
      keyCount?: number;
    } = {}
  ): void {
    span.setAttributes({
      "cache.operation": operation,
      "cache.key_prefix": this.prefix,
    });

    if (options.hit !== undefined) {
      span.setAttribute("cache.hit", options.hit);
    }

    if (options.ttlSeconds !== undefined) {
      span.setAttribute("cache.ttl_seconds", options.ttlSeconds);
    }

    if (options.keyCount !== undefined) {
      span.setAttribute("cache.key_count", options.keyCount);
    }
  }

  /**
   * Record cache operation metric
   */
  private recordMetric(
    operation: string,
    status: "hit" | "miss" | "success" | "error"
  ): void {
    cacheOperationsCounter.add(1, {
      operation,
      status,
      "cache.key_prefix": this.prefix,
    });
  }

  /**
   * Get a value from cache
   * @param key - Cache key (prefix will be added automatically)
   * @returns The cached value or null if not found
   */
  async get<T>(key: string): Promise<T | null> {
    return tracer.startActiveSpan("cache.get", async (span) => {
      const fullKey = this.buildKey(key);

      try {
        const value = await redis.get(fullKey);

        if (value === null) {
          this.metrics.misses++;
          this.addSpanAttributes(span, "get", { hit: false });
          this.recordMetric("get", "miss");
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return null;
        }

        this.metrics.hits++;
        this.addSpanAttributes(span, "get", { hit: true });
        this.recordMetric("get", "hit");
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        try {
          return JSON.parse(value) as T;
        } catch {
          // If JSON parse fails, return the raw string value
          return value as unknown as T;
        }
      } catch (error) {
        this.addSpanAttributes(span, "get");
        this.recordMetric("get", "error");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
  }

  /**
   * Set a value in cache
   * @param key - Cache key (prefix will be added automatically)
   * @param value - Value to cache (will be JSON serialized)
   * @param ttlSeconds - Optional TTL in seconds
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    return tracer.startActiveSpan("cache.set", async (span) => {
      const fullKey = this.buildKey(key);
      const serialized = JSON.stringify(value);

      try {
        if (ttlSeconds !== undefined && ttlSeconds > 0) {
          await redis.set(fullKey, serialized, "EX", ttlSeconds);
          this.addSpanAttributes(span, "set", { ttlSeconds });
        } else {
          await redis.set(fullKey, serialized);
          this.addSpanAttributes(span, "set");
        }

        this.recordMetric("set", "success");
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch (error) {
        this.addSpanAttributes(span, "set", { ttlSeconds });
        this.recordMetric("set", "error");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
  }

  /**
   * Delete a key from cache
   * @param key - Cache key (prefix will be added automatically)
   */
  async delete(key: string): Promise<void> {
    return tracer.startActiveSpan("cache.delete", async (span) => {
      const fullKey = this.buildKey(key);

      try {
        await redis.del(fullKey);
        this.addSpanAttributes(span, "delete");
        this.recordMetric("delete", "success");
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch (error) {
        this.addSpanAttributes(span, "delete");
        this.recordMetric("delete", "error");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
  }

  /**
   * Delete all keys matching a pattern using SCAN + DEL
   * Pattern supports Redis glob-style patterns (* ? [])
   * @param pattern - Pattern to match (prefix will be added automatically)
   * @returns Number of keys deleted
   */
  async deleteByPattern(pattern: string): Promise<number> {
    return tracer.startActiveSpan("cache.deleteByPattern", async (span) => {
      const fullPattern = this.buildKey(pattern);
      let cursor = "0";
      let deletedCount = 0;

      try {
        do {
          // SCAN returns [cursor, keys]
          const [nextCursor, keys] = await redis.scan(
            cursor,
            "MATCH",
            fullPattern,
            "COUNT",
            100
          );
          cursor = nextCursor;

          if (keys.length > 0) {
            await redis.del(...keys);
            deletedCount += keys.length;
          }
        } while (cursor !== "0");

        this.addSpanAttributes(span, "deleteByPattern", {
          keyCount: deletedCount,
        });
        this.recordMetric("deleteByPattern", "success");
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        return deletedCount;
      } catch (error) {
        this.addSpanAttributes(span, "deleteByPattern", {
          keyCount: deletedCount,
        });
        this.recordMetric("deleteByPattern", "error");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
  }

  /**
   * Bulk get - retrieve multiple values at once using Redis MGET
   * @param keys - Array of cache keys (prefix will be added automatically)
   * @returns Array of values in same order as keys (null for misses)
   */
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    return tracer.startActiveSpan("cache.mget", async (span) => {
      if (keys.length === 0) {
        this.addSpanAttributes(span, "mget", { keyCount: 0 });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return [];
      }

      const fullKeys = keys.map((key) => this.buildKey(key));

      try {
        const values = await redis.mget(...fullKeys);

        let hits = 0;
        let misses = 0;

        const results = values.map((value) => {
          if (value === null) {
            misses++;
            return null;
          }

          hits++;

          try {
            return JSON.parse(value) as T;
          } catch {
            // If JSON parse fails, return the raw string value
            return value as unknown as T;
          }
        });

        // Update metrics
        this.metrics.hits += hits;
        this.metrics.misses += misses;

        this.addSpanAttributes(span, "mget", { keyCount: keys.length });
        span.setAttribute("cache.hits", hits);
        span.setAttribute("cache.misses", misses);

        // Record individual hit/miss metrics
        if (hits > 0) {
          cacheOperationsCounter.add(hits, {
            operation: "mget",
            status: "hit",
            "cache.key_prefix": this.prefix,
          });
        }
        if (misses > 0) {
          cacheOperationsCounter.add(misses, {
            operation: "mget",
            status: "miss",
            "cache.key_prefix": this.prefix,
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        return results;
      } catch (error) {
        this.addSpanAttributes(span, "mget", { keyCount: keys.length });
        this.recordMetric("mget", "error");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
  }

  /**
   * Bulk set - set multiple key-value pairs at once using a Redis pipeline
   * @param entries - Array of entries with key, value, and optional TTL
   */
  async mset<T>(entries: MSetEntry<T>[]): Promise<void> {
    return tracer.startActiveSpan("cache.mset", async (span) => {
      if (entries.length === 0) {
        this.addSpanAttributes(span, "mset", { keyCount: 0 });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return;
      }

      try {
        // Use a pipeline for atomic execution
        const pipeline = redis.pipeline();

        for (const entry of entries) {
          const fullKey = this.buildKey(entry.key);
          const serialized = JSON.stringify(entry.value);

          if (entry.ttl !== undefined && entry.ttl > 0) {
            pipeline.set(fullKey, serialized, "EX", entry.ttl);
          } else {
            pipeline.set(fullKey, serialized);
          }
        }

        await pipeline.exec();

        this.addSpanAttributes(span, "mset", { keyCount: entries.length });
        this.recordMetric("mset", "success");
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch (error) {
        this.addSpanAttributes(span, "mset", { keyCount: entries.length });
        this.recordMetric("mset", "error");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
  }

  /**
   * Get cache hit rate as a percentage
   * @returns Hit rate between 0 and 1, or 0 if no requests
   */
  getHitRate(): number {
    const total = this.metrics.hits + this.metrics.misses;
    if (total === 0) {
      return 0;
    }
    return this.metrics.hits / total;
  }

  /**
   * Get current cache metrics
   */
  getMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset cache metrics
   */
  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
    };
  }

  /**
   * Get the key prefix
   */
  getPrefix(): string {
    return this.prefix;
  }
}

// Export singleton instance with default prefix
export const cache = new CacheService();
