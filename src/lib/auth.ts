import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Pool } from "pg";
import { sendVerificationEmail, sendPasswordResetEmail } from "./email.js";
import { redis } from "./redis.js";

// Initialize PostgreSQL connection pool from DATABASE_URL
// Format: postgresql://user:password@host:port/database?schema=auth
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const pool = new Pool({
  connectionString: databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // CRITICAL: Set search_path for Better Auth to find tables in auth schema
  // Better Auth's databaseSchema config doesn't work with Kysely+PostgreSQL
  // See: https://github.com/better-auth/better-auth/blob/canary/docs/content/docs/adapters/postgresql.mdx
  options: "-c search_path=auth",
});

export const auth = betterAuth({
  database: pool,

  // Use separate auth schema as per CODE_GUIDE.md
  databaseSchema: "auth",

  // Base URL configuration (subdomain routing)
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3002",

  // CRITICAL: Set basePath to "/" for subdomain routing
  // Default is "/api/auth" which breaks subdomain architecture
  basePath: "/",

  // Secret for signing tokens
  secret: process.env.BETTER_AUTH_SECRET,

  // Secondary storage using ValKey/Redis for session data
  secondaryStorage: {
    get: async (key) => {
      return await redis.get(key);
    },
    set: async (key, value, ttl) => {
      if (ttl) {
        await redis.set(key, value, "EX", ttl);
      } else {
        await redis.set(key, value);
      }
    },
    delete: async (key) => {
      await redis.del(key);
    },
  },

  // Plugins
  plugins: [
    jwt({
      jwks: {
        modelName: "jwks", // Explicitly set the model name
        keyPairConfig: {
          alg: "RS256", // Use RS256 for better compatibility with python-jose
        },
      },
      jwt: {
        issuer: process.env.BETTER_AUTH_URL || "http://localhost:3002",
        audience: process.env.BETTER_AUTH_URL || "http://localhost:3002",
        expirationTime: "24h",
      },
    }),
  ],

  // Email/password authentication
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
    sendResetPassword: async ({ user, url, token }) => {
      await sendPasswordResetEmail(user.email, url, token);
    },
  },

  // Email verification configuration
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url, token }) => {
      // The URL already contains callbackURL if client provided it during sign-up
      await sendVerificationEmail(user.email, url, token);
    },
    async afterEmailVerification(user) {
      console.log(`✅ Email verified for user: ${user.email}`);
      // User will be auto-signed in and redirected to callbackURL (if provided by client)
    },
  },

  // Social providers
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },

  // Session configuration with plural table name
  session: {
    modelName: "sessions",
    expiresIn: Number(process.env.SESSION_EXPIRES_IN) || 86400, // 24 hours
    updateAge: Number(process.env.SESSION_UPDATE_AGE) || 3600, // 1 hour
    cookieCache: {
      enabled: true,
      maxAge: 300, // 5 minutes
    },
  },

  // User configuration with plural table names per CODE_GUIDE.md
  user: {
    modelName: "users",
    additionalFields: {
      organizationId: {
        type: "string",
        required: false,
      },
    },
  },

  // Table name configuration - use plural for all tables
  account: {
    modelName: "accounts",
  },

  verification: {
    modelName: "verifications",
  },

  // Advanced configuration
  advanced: {
    cookiePrefix: process.env.COOKIE_PREFIX || "auth",
    useSecureCookies: process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging",
    // Cross-subdomain cookie configuration
    // Based on working examples: https://github.com/better-auth/better-auth/discussions/5670
    crossSubDomainCookies: {
      enabled: !!process.env.COOKIE_DOMAIN,
      // CRITICAL: Leading dot required for cross-subdomain cookies
      domain: process.env.COOKIE_DOMAIN ? `.${process.env.COOKIE_DOMAIN}` : undefined,
    },
    // Default cookie attributes for cross-domain OAuth
    // Based on: https://github.com/better-auth/better-auth/discussions/5670
    defaultCookieAttributes: {
      sameSite: process.env.NODE_ENV === "development" ? "lax" : "none", // "none" required for cross-domain OAuth
      secure: true, // Required with sameSite: "none"
      httpOnly: true,
      partitioned: false, // Prevent browsers from blocking partitioned cookies
      domain: process.env.NODE_ENV === "development"
        ? "localhost"
        : undefined, // Let crossSubDomainCookies handle the domain
      path: "/",
    },
  },

  // Rate limiting
  // Environment-specific limits: dev/staging more lenient, production stricter
  rateLimit: {
    enabled: true,
    window: 60, // seconds
    max: process.env.NODE_ENV === "production" ? 100 : 300, // requests per window
  },

  // Trusted origins for CORS
  trustedOrigins: [
    process.env.FRONTEND_URL || "http://localhost:5173",
    process.env.API_URL || "http://localhost:3001",
  ],
});

// Export types for TypeScript
export type Session = typeof auth.$Infer.Session;