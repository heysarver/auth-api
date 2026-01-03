import Redis from "ioredis";

/**
 * Logger interface for dependency injection
 * Allows custom logging integration (e.g., OpenTelemetry, structured logging)
 */
export interface RedisLogger {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Default console logger implementation
 * Used when no custom logger is provided
 */
const defaultLogger: RedisLogger = {
  info: (message: string, ...args: unknown[]) => console.log(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  debug: (message: string, ...args: unknown[]) => console.debug(message, ...args),
};

// Current logger instance (can be replaced via setLogger)
let logger: RedisLogger = defaultLogger;

/**
 * Set a custom logger for Redis operations
 * @param customLogger - Logger implementation to use
 */
export function setLogger(customLogger: RedisLogger): void {
  logger = customLogger;
}

/**
 * Get the current logger instance
 * @returns Current logger
 */
export function getLogger(): RedisLogger {
  return logger;
}

/**
 * Reset logger to default console logger
 * Useful for testing or resetting state
 */
export function resetLogger(): void {
  logger = defaultLogger;
}

// Initialize Redis (ValKey) connection for session storage
// Supports both Sentinel (production) and standalone (development) modes
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
const sentinelHost = process.env.VALKEY_SENTINEL_HOST;
const sentinelPort = parseInt(process.env.VALKEY_SENTINEL_PORT || "26379");
const sentinelMasterName = process.env.VALKEY_SENTINEL_MASTER_NAME || "mymaster";

// Use Sentinel configuration if VALKEY_SENTINEL_HOST is provided
// Otherwise fall back to direct connection
export const redis = sentinelHost
  ? new Redis({
      sentinels: [{ host: sentinelHost, port: sentinelPort }],
      name: sentinelMasterName,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError(err) {
        const targetError = "READONLY";
        if (err.message.includes(targetError)) {
          // Reconnect when Redis is in readonly mode (failover scenario)
          return true;
        }
        return false;
      },
      sentinelRetryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
    })
  : new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError(err) {
        const targetError = "READONLY";
        if (err.message.includes(targetError)) {
          // Reconnect when Redis is in readonly mode
          return true;
        }
        return false;
      },
    });

// Log connection mode and events
if (sentinelHost) {
  logger.info(`📡 Using Valkey Sentinel mode: ${sentinelHost}:${sentinelPort} (master: ${sentinelMasterName})`);
} else {
  logger.info(`📡 Using Valkey standalone mode: ${redisUrl}`);
}

redis.on("connect", () => {
  logger.info("✅ Redis connected");
});

redis.on("error", (err) => {
  logger.error("❌ Redis connection error:", err);
});

redis.on("close", () => {
  logger.warn("⚠️ Redis connection closed");
});

// Track if cleanup handlers have been registered
let cleanupHandlersRegistered = false;

// Store signal handlers for potential removal
let sigintHandler: (() => Promise<void>) | null = null;
let sigtermHandler: (() => Promise<void>) | null = null;

/**
 * Disconnect Redis client gracefully
 * Can be called directly for explicit cleanup
 * @returns Promise that resolves when disconnected
 */
export async function disconnect(): Promise<void> {
  logger.info("🔌 Disconnecting Redis client...");
  await redis.quit();
  logger.info("✅ Redis client disconnected");
}

/**
 * Register process signal handlers for graceful shutdown
 * Should be called once at application startup (e.g., in index.ts)
 * Idempotent - calling multiple times has no effect
 */
export function registerCleanupHandlers(): void {
  if (cleanupHandlersRegistered) {
    logger.debug("Cleanup handlers already registered, skipping");
    return;
  }

  sigintHandler = async () => {
    await disconnect();
    process.exit(0);
  };

  sigtermHandler = async () => {
    await disconnect();
    process.exit(0);
  };

  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  cleanupHandlersRegistered = true;
  logger.debug("Redis cleanup handlers registered");
}

/**
 * Unregister process signal handlers
 * Useful for testing or when cleanup timing needs to be controlled
 */
export function unregisterCleanupHandlers(): void {
  if (!cleanupHandlersRegistered) {
    return;
  }

  if (sigintHandler) {
    process.removeListener("SIGINT", sigintHandler);
    sigintHandler = null;
  }

  if (sigtermHandler) {
    process.removeListener("SIGTERM", sigtermHandler);
    sigtermHandler = null;
  }

  cleanupHandlersRegistered = false;
  logger.debug("Redis cleanup handlers unregistered");
}

/**
 * Check if cleanup handlers are currently registered
 * @returns true if handlers are registered
 */
export function areCleanupHandlersRegistered(): boolean {
  return cleanupHandlersRegistered;
}
