/**
 * Cloudflare Turnstile server-side verification
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
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

  // Development mode bypass token
  if (token === "DEVELOPMENT_MODE_BYPASS") {
    console.log("⚠️  Turnstile development mode bypass token accepted");
    return true;
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
      return false;
    }

    console.log("✅ Turnstile verification successful");
    return true;
  } catch (error) {
    console.error("❌ Turnstile verification error:", error);
    return false;
  }
}
