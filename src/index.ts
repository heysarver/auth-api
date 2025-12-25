import dotenv from "dotenv";

// Load environment variables FIRST before importing modules that use them
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { toNodeHandler } from "better-auth/node";
import { auth, pool } from "./lib/auth.js";
import { validateTurnstileToken } from "./middleware/turnstile.js";

const app = express();
const PORT = process.env.PORT || 3002;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
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
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
});
app.use("/api/", limiter);

// Turnstile verification middleware (before Better Auth)
app.use("/api/auth", validateTurnstileToken);

// Better Auth handler (Express v5 uses /*splat syntax for catch-all routes)
app.all("/api/auth/*splat", toNodeHandler(auth));

// Body parser middleware AFTER Better Auth handler
// (Better Auth handles its own body parsing)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint with database connectivity test
app.get("/health", async (_req, res) => {
  const errors: string[] = [];

  // Check database connectivity
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    errors.push(`Database unhealthy: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length > 0) {
    return res.status(503).json({
      status: "unhealthy",
      service: "auth-api",
      timestamp: new Date().toISOString(),
      errors,
    });
  }

  return res.json({
    status: "healthy",
    service: "auth-api",
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint
app.get("/", (_req, res) => {
  res.json({
    service: "Auth API",
    version: "1.0.0",
    documentation: "/api/auth",
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Cannot ${req.method} ${req.path}`,
  });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Auth API server running on http://localhost:${PORT}`);
  console.log(`📝 Auth endpoints available at http://localhost:${PORT}/api/auth/*`);
  console.log(`🏥 Health check at http://localhost:${PORT}/health`);
});
