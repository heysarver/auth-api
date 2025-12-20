import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { sendVerificationEmail, sendPasswordResetEmail } from "./email";

/**
 * Secure Better-Auth Configuration
 *
 * SECURITY IMPROVEMENTS:
 * - Strict callback URL validation
 * - PKCE enforcement for OAuth flows
 * - State parameter validation
 * - Exact redirect URI matching
 */

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Allowed OAuth callback URLs - must be explicitly whitelisted
const environment = process.env.NODE_ENV || 'development';
const productionDomain = process.env.PRODUCTION_DOMAIN || 'example.com';
const stagingDomain = process.env.STAGING_DOMAIN || 'staging.example.com';
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

const ALLOWED_OAUTH_CALLBACKS = {
  development: [
    `${frontendUrl}/auth/callback/github`,
    `${frontendUrl}/auth/callback/google`,
    `${frontendUrl}/dashboard`,
  ],
  staging: [
    `https://${stagingDomain}/auth/callback/github`,
    `https://${stagingDomain}/auth/callback/google`,
    `https://${stagingDomain}/dashboard`,
  ],
  production: [
    `https://${productionDomain}/auth/callback/github`,
    `https://${productionDomain}/auth/callback/google`,
    `https://${productionDomain}/dashboard`,
  ],
};

const allowedCallbacks = ALLOWED_OAUTH_CALLBACKS[environment as keyof typeof ALLOWED_OAUTH_CALLBACKS];

/**
 * Validate callback URL against whitelist
 * Implements exact matching to prevent open redirect vulnerabilities
 */
function validateCallbackURL(url: string): boolean {
  try {
    const parsedUrl = new URL(url);

    // Exact matching - no wildcards or partial matches
    const isAllowed = allowedCallbacks.some(allowed => {
      const allowedUrl = new URL(allowed);
      return (
        parsedUrl.protocol === allowedUrl.protocol &&
        parsedUrl.host === allowedUrl.host &&
        parsedUrl.pathname === allowedUrl.pathname
      );
    });

    if (!isAllowed) {
      console.warn(`Blocked unauthorized callback URL: ${url}`);
    }

    return isAllowed;
  } catch (error) {
    console.error('Invalid callback URL:', error);
    return false;
  }
}

export const auth = betterAuth({
  database: pool,

  // Use separate auth schema
  databaseSchema: "auth",

  // Base URL configuration
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3002",

  // Secret for signing tokens
  secret: process.env.BETTER_AUTH_SECRET,

  // Email/password authentication
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
    sendResetPassword: async ({ user, url, token }) => {
      // Validate reset URL before sending
      if (!validateCallbackURL(url)) {
        throw new Error('Invalid password reset URL');
      }
      await sendPasswordResetEmail(user.email, url, token);
    },
  },

  // Email verification configuration
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url, token }) => {
      // Validate verification URL before sending
      if (!validateCallbackURL(url)) {
        throw new Error('Invalid verification URL');
      }
      await sendVerificationEmail(user.email, url, token);
    },
    async afterEmailVerification(user) {
      console.log(`✅ Email verified for user: ${user.email}`);
    },
  },

  // Social providers with strict redirect URI configuration
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      // Enforce specific redirect URI registered with GitHub
      redirectURI: environment === 'production'
        ? `https://${productionDomain}/auth/callback/github`
        : `${frontendUrl}/auth/callback/github`,
      // Enable PKCE for OAuth 2.1 compliance
      pkce: true,
      // Set specific scopes
      scopes: ['read:user', 'user:email'],
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      redirectURI: environment === 'production'
        ? `https://${productionDomain}/auth/callback/google`
        : `${frontendUrl}/auth/callback/google`,
      // Enable PKCE for OAuth 2.1 compliance
      pkce: true,
      // Set specific scopes
      scopes: ['openid', 'profile', 'email'],
    },
  },

  // Session configuration
  session: {
    modelName: "sessions",
    expiresIn: Number(process.env.SESSION_EXPIRES_IN) || 86400, // 24 hours
    updateAge: Number(process.env.SESSION_UPDATE_AGE) || 3600, // 1 hour
    cookieCache: {
      enabled: true,
      maxAge: 300, // 5 minutes
    },
  },

  // User configuration
  user: {
    modelName: "users",
    additionalFields: {
      organizationId: {
        type: "string",
        required: false,
      },
    },
  },

  // Table name configuration
  account: {
    modelName: "accounts",
  },

  verification: {
    modelName: "verifications",
  },

  // Advanced security configuration
  advanced: {
    cookiePrefix: process.env.COOKIE_PREFIX || "auth",
    useSecureCookies: environment === 'production',
    crossSubDomainCookies: {
      enabled: false, // Disable for security
    },
    defaultCookieAttributes: {
      secure: environment === 'production', // HTTPS only in production
      httpOnly: true, // Prevent XSS
      sameSite: 'lax' as const, // CSRF protection
      path: '/',
    },
  },

  // Rate limiting with custom rules for sensitive endpoints
  rateLimit: {
    enabled: true,
    window: 60, // seconds
    max: 10, // requests per window
    // Custom rate limits for sensitive endpoints
    customRules: {
      '/sign-in/email': {
        window: 300, // 5 minutes
        max: 5, // 5 attempts per 5 minutes
      },
      '/sign-up/email': {
        window: 3600, // 1 hour
        max: 3, // 3 signups per hour per IP
      },
    },
  },

  // Trusted origins for CORS - exact matching only
  trustedOrigins: environment === 'production'
    ? [`https://${productionDomain}`]
    : [frontendUrl, process.env.API_URL || 'http://localhost:3001'],
});

// Export types for TypeScript
export type Session = typeof auth.$Infer.Session;
