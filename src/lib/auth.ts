import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { Pool } from "pg";
import { sendVerificationEmail, sendPasswordResetEmail } from "./email";

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
});

export const auth = betterAuth({
  database: pool,

  // Use separate auth schema as per CODE_GUIDE.md
  databaseSchema: "auth",

  // Base URL configuration
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3002",

  // Secret for signing tokens
  secret: process.env.BETTER_AUTH_SECRET,

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
    sendResetPassword: async ({ user, url, token }, request) => {
      await sendPasswordResetEmail(user.email, url, token);
    },
  },

  // Email verification configuration
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url, token }, request) => {
      // The URL already contains callbackURL if client provided it during sign-up
      await sendVerificationEmail(user.email, url, token);
    },
    async afterEmailVerification(user, request) {
      console.log(`✅ Email verified for user: ${user.email}`);
      // User will be auto-signed in and redirected to callbackURL (if provided by client)
    },
  },

  // Social providers
  socialProviders: {
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
    useSecureCookies: process.env.NODE_ENV === "production",
    crossSubDomainCookies: {
      enabled: false,
    },
    // For development: Allow cookies to work across different localhost ports
    defaultCookieAttributes: {
      sameSite: "lax",
      domain: process.env.NODE_ENV === "production" ? undefined : "localhost",
      path: "/",
    },
  },

  // Rate limiting
  rateLimit: {
    enabled: true,
    window: 60, // seconds
    max: 10, // requests per window
  },

  // Trusted origins for CORS
  trustedOrigins: [
    process.env.FRONTEND_URL || "http://localhost:5173",
    process.env.API_URL || "http://localhost:3001",
  ],
});

// Export types for TypeScript
export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.User;