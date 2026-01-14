/**
 * Cloudflare Turnstile server-side verification
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

import { createHash } from "crypto";
import { redis } from "./redis.js";

// Cache TTL for successful Turnstile verifications (10 minutes)
const TURNSTILE_CACHE_TTL = 600; // 10 minutes

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
}

/**
 * Generate a cache key for a Turnstile token
 * Uses SHA256 hash of first 32 characters of token + client IP
 */
function generateCacheKey(token: string, clientIp: string): string {
  const tokenPrefix = token.substring(0, 32);
  const hash = createHash("sha256").update(tokenPrefix).digest("hex");
  return `turnstile:${hash}:${clientIp}`;
}

/**
 * Verify a Turnstile token with Cloudflare
 * @param token - The Turnstile response token from the client
 * @param remoteip - Optional: The user's IP address
 * @returns Promise<boolean> - true if verification succeeds, false otherwise
 */
export async function verifyTurnstileToken(
  token: string,
  remoteip?: string
): Promise<boolean> {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;

  // In development mode, allow bypass if Turnstile is disabled
  if (process.env.TURNSTILE_ENABLED !== "true") {
    console.log("⚠️  Turnstile verification disabled (development mode)");
    return true;
  }

  // Validate that secret key is configured
  if (!secretKey) {
    console.error("❌ TURNSTILE_SECRET_KEY not configured");
    return false;
  }

  // Validate token format
  if (!token || typeof token !== "string") {
    console.error("❌ Invalid Turnstile token format");
    return false;
  }

  // Development mode bypass - requires explicit opt-in via env var
  // NEVER works in production, even with env var set
  const bypassToken = process.env.TURNSTILE_BYPASS_TOKEN;
  if (
    process.env.NODE_ENV !== "production" &&
    bypassToken &&
    token === bypassToken
  ) {
    console.log("⚠️  Turnstile development mode bypass token accepted");
    return true;
  }

  // Check cache for previously verified token (single-use)
  const clientIp = remoteip || "unknown";
  const cacheKey = generateCacheKey(token, clientIp);

  try {
    const cachedResult = await redis.get(cacheKey);
    if (cachedResult !== null) {
      // Cache hit - delete the entry (single-use tokens)
      await redis.del(cacheKey);
      console.log("Turnstile verification cache hit");
      return cachedResult === "true";
    }
  } catch (error) {
    // Cache error - continue with API verification
    console.error("⚠️ Turnstile cache error:", error);
  }

  try {
    // Verify with Cloudflare Turnstile API
    const formData = new URLSearchParams();
    formData.append("secret", secretKey);
    formData.append("response", token);
    if (remoteip) {
      formData.append("remoteip", remoteip);
    }

    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      }
    );

    if (!response.ok) {
      console.error(
        `❌ Turnstile verification request failed: ${response.status} ${response.statusText}`
      );
      return false;
    }

    const result = (await response.json()) as TurnstileResponse;

    if (!result.success) {
      console.error(
        "❌ Turnstile verification failed:",
        result["error-codes"] || "Unknown error"
      );
      // Do NOT cache failed verifications
      return false;
    }

    // Cache successful verification
    try {
      await redis.setex(cacheKey, TURNSTILE_CACHE_TTL, "true");
    } catch (error) {
      // Cache error - log but don't fail the verification
      console.error("⚠️ Failed to cache Turnstile verification:", error);
    }

    console.log("✅ Turnstile verification successful");
    return true;
  } catch (error) {
    console.error("❌ Turnstile verification error:", error);
    return false;
  }
}
