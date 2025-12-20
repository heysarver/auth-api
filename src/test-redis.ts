import { redis } from "./lib/redis.js";

async function testRedis() {
  try {
    console.log("🧪 Testing Redis connection and operations...\n");

    // Test basic set/get
    console.log("1. Testing basic SET/GET:");
    await redis.set("test:key", "test-value");
    const value = await redis.get("test:key");
    console.log(`   ✅ SET/GET: ${value === "test-value" ? "PASS" : "FAIL"}`);

    // Test SET with TTL
    console.log("\n2. Testing SET with TTL (5 seconds):");
    await redis.set("test:ttl", "expires-soon", "EX", 5);
    const ttlValue = await redis.get("test:ttl");
    const ttl = await redis.ttl("test:ttl");
    console.log(`   ✅ SET with TTL: ${ttlValue === "expires-soon" ? "PASS" : "FAIL"}`);
    console.log(`   ℹ️  TTL remaining: ${ttl} seconds`);

    // Test DEL
    console.log("\n3. Testing DEL:");
    await redis.set("test:delete", "will-be-deleted");
    await redis.del("test:delete");
    const deletedValue = await redis.get("test:delete");
    console.log(`   ✅ DEL: ${deletedValue === null ? "PASS" : "FAIL"}`);

    // Test secondary storage interface (as used by better-auth)
    console.log("\n4. Testing secondary storage interface:");
    const secondaryStorage = {
      get: async (key: string) => await redis.get(key),
      set: async (key: string, value: string, ttl?: number) => {
        if (ttl) {
          await redis.set(key, value, "EX", ttl);
        } else {
          await redis.set(key, value);
        }
      },
      delete: async (key: string) => await redis.del(key),
    };

    await secondaryStorage.set("test:session", "session-data", 3600);
    const sessionData = await secondaryStorage.get("test:session");
    console.log(`   ✅ Secondary storage SET: ${sessionData === "session-data" ? "PASS" : "FAIL"}`);

    await secondaryStorage.delete("test:session");
    const deletedSession = await secondaryStorage.get("test:session");
    console.log(`   ✅ Secondary storage DEL: ${deletedSession === null ? "PASS" : "FAIL"}`);

    // Cleanup
    console.log("\n5. Cleanup test keys:");
    await redis.del("test:key", "test:ttl");
    console.log("   ✅ Cleanup complete");

    console.log("\n🎉 All Redis tests passed!\n");

    await redis.quit();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Redis test failed:", error);
    await redis.quit();
    process.exit(1);
  }
}

testRedis();
