/**
 * Express middleware for Turnstile token validation
 */

import type { Request, Response, NextFunction } from "express";
import { verifyTurnstileToken } from "../lib/turnstile.js";

/**
 * Middleware to validate Turnstile token for authentication endpoints
 * Checks for cf-turnstile-response in request body
 */
export async function validateTurnstileToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Only validate on sign-up and sign-in endpoints
  const isAuthEndpoint =
    req.path === "/sign-up/email" || req.path === "/sign-in/email";

  if (!isAuthEndpoint) {
    return next();
  }

  // Extract Turnstile token from request body
  const turnstileToken = req.body["cf-turnstile-response"];

  if (!turnstileToken) {
    console.warn("⚠️  No Turnstile token provided for", req.path);

    // If Turnstile is disabled in development, allow request
    if (process.env.TURNSTILE_ENABLED !== "true") {
      console.log("⚠️  Turnstile disabled - allowing request without token");
      return next();
    }

    // In production, reject requests without Turnstile token
    res.status(400).json({
      error: "Bad Request",
      message: "Turnstile verification required",
    });
    return;
  }

  // Verify the Turnstile token
  const clientIp = req.ip || req.socket.remoteAddress;
  const isValid = await verifyTurnstileToken(turnstileToken, clientIp);

  if (!isValid) {
    console.error("❌ Turnstile verification failed for", req.path);
    res.status(403).json({
      error: "Forbidden",
      message: "Turnstile verification failed. Please try again.",
    });
    return;
  }

  // Token is valid, proceed to Better Auth
  console.log("✅ Turnstile verification passed for", req.path);
  next();
}
