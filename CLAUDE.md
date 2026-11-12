# CLAUDE.md

This file provides guidance to coding agents working in this repository.

## Service Overview

This is the **auth-api** microservice, handling authentication using Better Auth. It runs on port 3002 and manages user authentication, sessions, OAuth flows, and email verification.

## Key Architecture Patterns

### ES Modules Configuration
- This project uses ES modules (`"type": "module"` in package.json)
- **CRITICAL**: All imports must use `.js` extensions even for TypeScript files
  - `import { auth } from "./lib/auth.js"` (correct)
  - `import { auth } from "./lib/auth"` (will fail)
- Development uses `tsx`, production uses compiled JavaScript from `tsc`

### Database Schema Separation
- Uses PostgreSQL with the `auth` schema exclusively
- **Never** interact with the `app` schema - that's managed by app-api
- Better Auth manages these tables in the auth schema:
  - `users` (plural, not `user`)
  - `sessions` (plural, not `session`)
  - `accounts` (plural, not `account`)
  - `verifications` (plural, not `verification`)
  - `jwks` (for JWT key storage)
- Table names are explicitly configured as plural via `modelName` in src/lib/auth.ts (users `:356`, sessions `:343`, accounts `:374`, verifications `:379`, jwks `:152`)

### Schema Management
- **Better Auth does not create or migrate tables.** Nothing in src/lib/auth.ts or src/index.ts runs a migration.
- The schema is owned by the Liquibase changelog under `migrations/`, with changesets in `migrations/changelog/changes/auth/`.
- A missing or stale table therefore fails at query time, not at boot. Apply migrations before starting a replica against a new database.
- Never hand-edit auth tables to "fix" drift. Add a changeset.

### Better Auth Integration
- Configuration in src/lib/auth.ts
- Uses PostgreSQL connection pool (not direct client)
- JWT plugin enabled with JWKS support
- **Secondary storage with Redis/ValKey** for session data and rate limiting (src/lib/redis.ts)
- Session cookies prefixed (configurable via COOKIE_PREFIX)
- Email verification uses SendGrid with fallback to plain HTML
- Table model names must match exactly: `users`, `sessions`, `accounts`, `verifications`, `jwks`
- `basePath` is `/` (src/lib/auth.ts:95), so every Better Auth route sits at the root, not under `/api/auth`

## Common Development Commands

```bash
# Development
npm install              # Install dependencies
npm run dev             # Start with hot reload (nodemon + tsx, loads .env)
npm run build           # Compile TypeScript to dist/ (tsc -p tsconfig.build.json)
npm start               # Run production build (node --import ./dist/instrumentation.js dist/index.js)
npm test                # Run the vitest suite
npm run lint            # ESLint
npm run test:coverage   # Coverage with thresholds

# Docker
docker build -t auth-api:latest .                       # Production image
docker build -f Dockerfile.dev -t auth-api:dev .        # Development image
docker run -p 3002:3002 --env-file .env auth-api:latest
docker logs -f <container>                              # Follow logs
```

There is no `docker-compose.yml` in this repository. Use `docker build` and `docker run`, or the orchestration manifests of the consuming deployment.

## File Structure

```
src/
├── index.ts              # Express app setup, middleware, routes, shutdown wiring
├── instrumentation.ts    # OpenTelemetry bootstrap, loaded before the app
├── test-email.ts         # Email testing utility
├── test-redis.ts         # Redis testing utility
├── middleware/
│   ├── rate-limit-credential.ts   # Per-credential (email) rate limiting
│   └── turnstile.ts               # Turnstile verification middleware
├── lib/
│   ├── auth.ts                     # Better Auth configuration (main)
│   ├── database-config.ts          # POSTGRES_POOL_MAX validation
│   ├── cookie-config.ts            # Cookie prefix, domain, SameSite, secure
│   ├── session-security.ts         # Session revocation guards
│   ├── email.ts                    # SendGrid email handlers
│   ├── email-verification-policy.ts
│   ├── redis.ts                    # Redis/ValKey client for secondary storage
│   ├── cache.ts                    # Response and health caching
│   ├── rate-limit-policy.ts        # Shared-IP skip policy
│   ├── shutdown.ts                 # Single owner of SIGTERM/SIGINT drain
│   ├── http-timeout.ts             # Outbound request timeouts
│   ├── turnstile.ts                # Cloudflare Turnstile verification
│   ├── oauth-config.ts             # OAuth provider configuration
│   ├── google-oauth-profile.ts     # Google profile mapping
│   ├── account-linking-config.ts   # Account linking policy
│   ├── marketkit-oauth-provider.ts # MarketKit OAuth provider extension
│   ├── token-introspection.ts      # POST /token/introspect
│   ├── workload-config.ts          # Workload identity configuration
│   ├── workload-token.ts           # Token issue and verify adapter
│   ├── workload-dpop.ts            # DPoP proof validation
│   ├── workload-routes.ts          # Workload route table
│   ├── workload-store.ts           # PostgreSQL workload state
│   ├── workload-errors.ts          # Redacted workload errors
│   └── boothwright-browser.ts      # Launched-browser test support
└── __tests__/
    ├── unit/
    └── integration/
```

## Important Implementation Details

### TypeScript Compilation
- Target: ES2022
- Output: dist/ directory
- Strict mode enabled
- `tsconfig.json` is the type-check config: `declaration` and `declarationMap` are off so tests and tooling do not emit types.
- `tsconfig.build.json` extends it, turns declarations on, and excludes `src/__tests__`. `npm run build` uses that file, so `dist/` never ships tests.
- Import resolution requires `.js` extensions

### Environment Variables
See `.env.example` for the full list and `README.md` for the documented table. The variables a reader must not get wrong:

- `DATABASE_URL` - Must include `?schema=auth` parameter
- `POSTGRES_POOL_MAX` - **Required in production and must equal exactly 10.** Unset in production throws at boot (src/lib/database-config.ts). Development defaults to 20; valid range 1-20.
- `REDIS_URL` - Redis/ValKey connection string for secondary storage (default: redis://localhost:6379/1)
- `BETTER_AUTH_SECRET` - Minimum 32 characters, shared with app-api for JWT validation. A short or missing value throws at boot.
- `BETTER_AUTH_URL` - Base URL for auth service (http://localhost:3002 in dev)
- `COOKIE_PREFIX` / `COOKIE_DOMAIN` - Cookie naming and cross-subdomain domain
- `SENDGRID_API_KEY` - Required for email verification (optional in dev)
- `GITHUB_CLIENT_ID/SECRET` - For OAuth (optional)
- `CORS_ORIGINS` / `FRONTEND_URL` / `API_URL` - CORS configuration
- `SESSION_EXPIRES_IN` / `SESSION_UPDATE_AGE` - Session lifetime and refresh interval
- `TOKEN_INTROSPECTION_*` - Machine credential, client id and rate limit for `/token/introspect`
- `WORKLOAD_*` - Workload identity profile; disabled unless `WORKLOAD_IDENTITY_ENABLED=true`
- `SHUTDOWN_TIMEOUT_MS` - Drain deadline, default 10000 ms. Keep below the pod `terminationGracePeriodSeconds`.

### Redis/ValKey Secondary Storage (src/lib/redis.ts)
- Configured via `REDIS_URL` environment variable
- Used by Better Auth for session data and rate limiting
- Implements SecondaryStorage interface: `get`, `set` (with TTL), `delete`
- Connection includes retry strategy and reconnection logic
- Also backs the express-rate-limit Redis stores (`auth:ratelimit:*`, `auth:ratelimit:introspection:*`, `auth:ratelimit:workload:*`)
- Graceful shutdown is owned by src/lib/shutdown.ts, which drains HTTP, Postgres, Redis and telemetry from one signal handler
- Test utility available: `tsx src/test-redis.ts`

### Email Handling (src/lib/email.ts)
- Uses SendGrid (`@sendgrid/mail`). There is no MailerSend dependency.
- Three main functions: `sendEmail`, `sendVerificationEmail`, `sendPasswordResetEmail`
- Supports SendGrid templates via `SENDGRID_VERIFICATION_TEMPLATE_ID` and `SENDGRID_RESET_TEMPLATE_ID`
- Falls back to inline HTML/text if templates not configured
- Gracefully degrades if SendGrid not configured (logs only)

### Middleware Stack (src/index.ts)
Order matters - configured as:
1. `trust proxy` (first, so ingress client IPs resolve correctly)
2. Helmet (security headers with CSP)
3. CORS (credentials enabled, specific origins)
4. Body parsers (JSON + URL-encoded, 16kb limit)
5. Parse-error redaction for token introspection and workload routes
6. `GET /health` - deliberately **above** the rate limiter so Kubernetes probes are never throttled
7. `GET /config/policy` - public auth policy for clients
8. Global rate limiter (15 minute window, 500 requests in production and 2000 otherwise, Redis-backed)
9. Credential rate limiter (per email, independent of IP)
10. `POST /token/introspect` with its own per-minute limiter
11. Workload identity router, when `WORKLOAD_IDENTITY_ENABLED` is true, with its own limiter
12. Turnstile verification, excluding `/health`, `/token`, `/token/introspect`, `/get-session`, `/jwks`
13. Better Auth catch-all handler (`app.all("/*splat")`)
14. Parse-error redaction again, as defense in depth
15. 404 handler
16. Error handler (includes stack in development only)
17. Shutdown handlers (SIGTERM/SIGINT drain)

### Authentication Endpoints
All Better Auth endpoints are at the **root path** (`basePath: "/"`), not under `/api/auth/*`:
- `POST /sign-up` - Register with email/password
- `POST /sign-in` - Sign in
- `POST /sign-out` - Sign out
- `GET /session` - Get current session
- `GET /github` - GitHub OAuth initiation
- `GET /callback/github` - GitHub OAuth callback
- `GET /jwks` - JWKS endpoint for JWT validation
- Additional Better Auth routes available (see Better Auth docs)

Other routes on the same origin:
- `POST /token/introspect` - Machine-authenticated bearer-token activity check
- `POST /workload/principals/grants`, `POST /workload/token`, `POST /workload/token/renew`, `POST /workload/token/introspect`, `POST /workload/revoke` - Workload identity, when enabled
- `GET /health`, `GET /config/policy`, `GET /`

### Session Configuration
- Expires in 24 hours (86400 seconds, `SESSION_EXPIRES_IN`)
- Updates age: 1 hour (3600 seconds, `SESSION_UPDATE_AGE`)
- Cookie cache enabled (5 minute max age)
- Cookies are secure in `production` and `staging`, not only production (src/lib/cookie-config.ts)
- SameSite is `lax` in development and `none` elsewhere, because the frontend sits on another subdomain
- Cookie domain is driven by `COOKIE_DOMAIN`: when set, cross-subdomain cookies are enabled with a leading-dot domain; when unset, Better Auth's own computation applies
- Cookie prefix is `COOKIE_PREFIX` or `auth`

### Security Features
- Helmet.js with strict CSP (allows self, data:, https: for images)
- Rate limiting per IP, plus a separate per-email credential limit
- CORS restricted to `CORS_ORIGINS`, falling back to `FRONTEND_URL` and `API_URL`
- Cloudflare Turnstile on unauthenticated entry points
- Password hashing via Better Auth's default hasher (bcrypt is not a dependency)
- JWT token signing with configurable expiration and JWKS publication

## Common Tasks

### Adding a New OAuth Provider
1. Add client ID/secret to .env: `PROVIDER_CLIENT_ID`, `PROVIDER_CLIENT_SECRET`
2. Update src/lib/auth.ts `socialProviders` section
3. Better Auth will automatically create routes

### Modifying Email Templates
1. For custom HTML: Edit src/lib/email.ts functions
2. For SendGrid templates: Set template IDs in .env
3. Templates support dynamic variables via `dynamicTemplateData`

### Testing Email Locally
1. Use src/test-email.ts script
2. Or leave `SENDGRID_API_KEY` empty to see console output only
3. Better Auth will call email functions with proper URLs

### Debugging Authentication Issues
1. Check logs: `docker logs -f <container>`
2. Verify database schema: `\dt auth.*` in psql
3. Ensure BETTER_AUTH_SECRET matches between auth-api and app-api
4. Check cookie domain and SameSite settings for localhost vs production
5. Verify CORS origins include the requesting frontend URL

### Working with the Database
- Connection pooling is set by `POSTGRES_POOL_MAX`: required and exactly 10 in production, default 20 elsewhere, 30s idle timeout, 2s connection timeout
- Schema is set to `auth` in connection configuration
- Better Auth does **not** auto-migrate. Apply the Liquibase changelog under `migrations/` before pointing a replica at a new database.
- Never manually modify auth schema tables. Change the changelog instead.

## Type Safety

```typescript
// Export types from Better Auth for use in other files
import type { Session, User } from "./lib/auth.js";

// Better Auth provides typed inference
const session: Session = await auth.api.getSession(request);
const user: User = session.user;
```

## Docker Configuration

### Development (Dockerfile.dev)
- Uses tsx directly (no compilation)
- Hot reload enabled
- Runs on port 3002

### Production (Dockerfile)
- Multi-stage build
- TypeScript compilation in builder stage
- Minimal runtime image
- Non-root user
- `HEALTHCHECK` against `/health`
- Production dependencies only (`npm ci --omit=dev`)
- **Node runs as PID 1** and receives Kubernetes SIGTERM directly. There is no `dumb-init` or other init shim. src/lib/shutdown.ts registers the SIGTERM handler and drains HTTP, Postgres, Redis and telemetry.

## Continuous Integration

`.github/workflows/ci.yml` runs lint, build and the test suite with a production audit gate. `.github/workflows/docker.yml` builds the image and boots it against a real Postgres to assert `/health`, on pull requests that change the Dockerfile or a dependency file.
