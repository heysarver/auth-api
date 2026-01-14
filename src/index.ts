// CRITICAL: Import instrumentation FIRST before any other code
// This ensures OpenTelemetry auto-instrumentation captures all telemetry
import "./instrumentation.js";

import dotenv from "dotenv";

// Load environment variables FIRST before importing modules that use them
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { toNodeHandler } from "better-auth/node";
import { auth, pool } from "./lib/auth.js";
import { redis, registerCleanupHandlers } from "./lib/redis.js";
import { validateTurnstileToken } from "./middleware/turnstile.js";

// Register Redis cleanup handlers for graceful shutdown
registerCleanupHandlers();

const app = express();
const PORT = process.env.PORT || 3002;

// Trust proxy when running behind ingress/load balancer
// This allows Express to use X-Forwarded-* headers for client IP detection
// Default: 1 (trust first proxy) - safe for typical k8s ingress
// Set TRUST_PROXY=true to trust all (less secure), or a specific IP/range
const trustProxy = process.env.TRUST_PROXY === "true" ? true :
                   process.env.TRUST_PROXY ? process.env.TRUST_PROXY :
                   1; // Default: trust first proxy only
app.set("trust proxy", trustProxy);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://challenges.cloudflare.com"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      styleSrcAttr: ["'unsafe-inline'"],
      frameSrc: ["'self'", "https://challenges.cloudflare.com"],
      connectSrc: ["'self'", "https://challenges.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));

// CORS configuration
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:5173",
    process.env.API_URL || "http://localhost:3001",
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "traceparent", "tracestate"],
  maxAge: 86400, // Cache preflight for 24 hours
}));

// Body parsing middleware (MUST be before routes)
// Explicit size limits prevent memory exhaustion attacks
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));

// Health check caching to reduce database load
let lastHealthCheck = 0;
let cachedHealthResult: { status: string; service: string; database: boolean; timestamp: string; errors?: string[] } | null = null;
const HEALTH_CACHE_TTL = 5000; // 5 seconds in milliseconds

// Health check endpoint - BEFORE rate limiting to prevent k8s probe failures
// This endpoint is called frequently by Kubernetes liveness/readiness probes
app.get("/health", async (_req, res) => {
  const now = Date.now();

  // Return cached result if still valid
  if (cachedHealthResult && (now - lastHealthCheck) < HEALTH_CACHE_TTL) {
    const statusCode = cachedHealthResult.status === "healthy" ? 200 : 503;
    return res.status(statusCode).json(cachedHealthResult);
  }

  const errors: string[] = [];
  let databaseHealthy = true;

  // Check database connectivity
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    databaseHealthy = false;
    errors.push(`Database unhealthy: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length > 0) {
    cachedHealthResult = {
      status: "unhealthy",
      service: "auth-api",
      database: databaseHealthy,
      timestamp: new Date().toISOString(),
      errors,
    };
    lastHealthCheck = now;
    return res.status(503).json(cachedHealthResult);
  }

  cachedHealthResult = {
    status: "healthy",
    service: "auth-api",
    database: databaseHealthy,
    timestamp: new Date().toISOString(),
  };
  lastHealthCheck = now;
  return res.json(cachedHealthResult);
});

// Rate limiting (with trust proxy configuration for Kubernetes ingress)
// Environment-specific limits: dev/staging more lenient, production stricter
// NOTE: Health check is ABOVE this to prevent k8s probes from being rate limited
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "production" ? 500 : 2000, // requests per window
  message: "Too many requests from this IP, please try again later.",
  // Trust the first proxy (nginx ingress) for IP detection
  // This prevents the ERR_ERL_PERMISSIVE_TRUST_PROXY error
  validate: { trustProxy: false }, // Disable default validation since we set trust proxy globally
  store: new RedisStore({
    // @ts-expect-error - ioredis call() returns unknown, but RedisStore expects Promise<any>
    sendCommand: (...args: string[]) => redis.call(...args) as Promise<any>,
    prefix: "auth:ratelimit:",
  }),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Turnstile verification middleware (after /health, before Better Auth)
// Subdomain routing: auth is on auth.domain.com with root paths
// IMPORTANT: Excludes authenticated endpoints from Turnstile verification
// These endpoints require session cookies, not Turnstile tokens
const excludedPaths = ["/health", "/token", "/get-session", "/jwks"];
app.use((req, res, next) => {
  if (excludedPaths.includes(req.path)) {
    return next();
  }
  return validateTurnstileToken(req, res, next);
});

// Better Auth handler (Express v5 uses /*splat syntax for catch-all routes)
// Subdomain routing: all auth endpoints at root (not /api/auth/*)
app.all("/*splat", toNodeHandler(auth));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Cannot ${req.method} ${req.path}`,
    code: "NOT_FOUND",
  });
});

// Error handler - consistent format with 404 handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Log error without exposing sensitive details in production
  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    console.error("Error:", err);
  } else {
    console.error("Error:", err.message || "Unknown error");
  }

  res.status(err.status || 500).json({
    error: err.name || "Internal Server Error",
    message: err.message || "An unexpected error occurred",
    code: err.code || "INTERNAL_ERROR",
    ...(!isProduction && { stack: err.stack }),
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Auth API server running on http://localhost:${PORT}`);
  console.log(`📝 Auth endpoints available at http://localhost:${PORT}/api/auth/*`);
  console.log(`🏥 Health check at http://localhost:${PORT}/health`);
});
