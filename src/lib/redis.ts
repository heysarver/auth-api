import Redis from "ioredis";

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
  console.log(`📡 Using Valkey Sentinel mode: ${sentinelHost}:${sentinelPort} (master: ${sentinelMasterName})`);
} else {
  console.log(`📡 Using Valkey standalone mode: ${redisUrl}`);
}

redis.on("connect", () => {
  console.log("✅ Redis connected");
});

redis.on("error", (err) => {
  console.error("❌ Redis connection error:", err);
});

redis.on("close", () => {
  console.log("⚠️ Redis connection closed");
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await redis.quit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await redis.quit();
  process.exit(0);
});
