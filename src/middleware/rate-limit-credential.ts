import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "../lib/redis.js";

/**
 * H2 — Per-credential (email) rate limit for auth endpoints.
 *
 * better-auth's built-in limiter and the global express limiter key by IP only,
 * so a single credential (email address) can be brute-forced from many IPs.
 * This middleware caps requests per normalized email on the sign-in and
 * forget-password routes, using the shared Redis store.
 *
 * Limits are environment-specific: production stricter. Defaults can be
 * overridden via CREDENTIAL_RATE_LIMIT_MAX / CREDENTIAL_RATE_LIMIT_WINDOW_SEC.
 */

const CREDENTIAL_RATE_LIMIT_PATHS = new Set([
  "/sign-in/email",
  "/request-password-reset",
]);

function readWindowMs(): number {
  return (Number(process.env.CREDENTIAL_RATE_LIMIT_WINDOW_SEC) || 60) * 1000;
}

function readMax(): number {
  return (
    Number(process.env.CREDENTIAL_RATE_LIMIT_MAX) ||
    (process.env.NODE_ENV === "production" ? 5 : 20)
  );
}

function readLimit(): number {
  return readMax();
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function extractEmail(req: Request): string | null {
  return normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
}

export interface CredentialRateLimitConfig {
  windowMs?: number;
  max?: number;
  message?: string;
}

export const DEFAULT_CREDENTIAL_RATE_LIMIT_MESSAGE =
  "Too many requests for this credential, please try again later.";

export const credentialRateLimitConfig = {
  get windowMs(): number {
    return readWindowMs();
  },
  get max(): number {
    return readMax();
  },
};

// One shared limiter for all matching requests; the store is created once.
// `limit` is read per request so CREDENTIAL_RATE_LIMIT_MAX is honored at
// runtime (module load captures only the default).
const credentialLimiter = rateLimit({
  windowMs: credentialRateLimitConfig.windowMs,
  limit: () => readLimit(),
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    // @ts-expect-error - ioredis call() returns unknown, RedisStore expects Promise<any>
    sendCommand: (...args: string[]) => redis.call(...args) as Promise<unknown>,
    prefix: "auth:credratelimit:",
  }),
  skip: (req: Request) => {
    if (!CREDENTIAL_RATE_LIMIT_PATHS.has(req.path)) return true;
    return !extractEmail(req);
  },
  keyGenerator: (req: Request) => `cred:${extractEmail(req)}`,
  message: DEFAULT_CREDENTIAL_RATE_LIMIT_MESSAGE,
});

/**
 * Async middleware so callers (and tests) can await completion.
 * On error, the limiter calls next(err) itself; returning its promise keeps
 * the async flow observable without double-invoking next.
 */
export async function credentialRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!CREDENTIAL_RATE_LIMIT_PATHS.has(req.path) || !extractEmail(req)) {
    next();
    return;
  }
  await credentialLimiter(req, res, next);
}
