# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- Table names are explicitly configured as plural in src/lib/auth.ts:14-100

### Better Auth Integration
- Configuration in src/lib/auth.ts
- Uses PostgreSQL connection pool (not direct client)
- JWT plugin enabled with JWKS support
- Session cookies prefixed (configurable via COOKIE_PREFIX)
- Email verification uses SendGrid with fallback to plain HTML
- Table model names must match exactly: `users`, `sessions`, `accounts`, `verifications`, `jwks`

## Common Development Commands

```bash
# Development
npm install              # Install dependencies
npm run dev             # Start with hot reload (tsx + nodemon)
npm run build           # Compile TypeScript to dist/
npm start               # Run production build

# Docker
docker compose up -d    # Start service in Docker
docker compose logs -f auth-api  # View logs
```

## File Structure

```
src/
├── index.ts              # Express app setup, middleware, routes
├── lib/
│   ├── auth.ts          # Better Auth configuration (main)
│   ├── auth-secure.ts   # Secure auth variant (if needed)
│   └── email.ts         # MailerSend email handlers
└── test-email.ts        # Email testing utility
```

## Important Implementation Details

### TypeScript Compilation
- Target: ES2022
- Output: dist/ directory
- Strict mode enabled
- Source maps and declarations generated
- Import resolution requires `.js` extensions

### Environment Variables
See .env.example for full documentation. Critical variables:
- `DATABASE_URL` - Must include `?schema=auth` parameter
- `BETTER_AUTH_SECRET` - Minimum 32 characters, shared with app-api for JWT validation
- `BETTER_AUTH_URL` - Base URL for auth service (http://localhost:3002 in dev)
- `SENDGRID_API_KEY` - Required for email verification (optional in dev)
- `GITHUB_CLIENT_ID/SECRET` - For OAuth (optional)
- `FRONTEND_URL` - For CORS configuration

### Email Handling (src/lib/email.ts)
- Three main functions: `sendEmail`, `sendVerificationEmail`, `sendPasswordResetEmail`
- Supports SendGrid templates via `SENDGRID_VERIFICATION_TEMPLATE_ID` and `SENDGRID_RESET_TEMPLATE_ID`
- Falls back to inline HTML/text if templates not configured
- Gracefully degrades if SendGrid not configured (logs only)

### Middleware Stack (src/index.ts)
Order matters - configured as:
1. Helmet (security headers with CSP)
2. CORS (credentials enabled, specific origins)
3. Rate limiting (100 req/15min on /api/*)
4. Body parsers (JSON + URL-encoded)
5. Better Auth handler at `/api/auth`
6. Custom routes (health check, root)
7. 404 handler
8. Error handler (includes stack in development)

### Authentication Endpoints
All Better Auth endpoints available at `/api/auth/*`:
- `POST /api/auth/sign-up` - Register with email/password
- `POST /api/auth/sign-in` - Sign in
- `POST /api/auth/sign-out` - Sign out
- `GET /api/auth/session` - Get current session
- `GET /api/auth/github` - GitHub OAuth initiation
- `GET /api/auth/callback/github` - GitHub OAuth callback
- Additional Better Auth routes available (see Better Auth docs)

### Session Configuration
- Expires in 24 hours (86400 seconds, configurable)
- Updates age: 1 hour (3600 seconds)
- Cookie cache enabled (5 minute max age)
- Secure cookies in production only
- SameSite: lax
- Domain: localhost in development, undefined in production

### Security Features
- Helmet.js with strict CSP (allows self, data:, https: for images)
- Rate limiting per IP
- CORS restricted to FRONTEND_URL and API_URL
- Secure cookies in production
- Password hashing via Better Auth
- JWT token signing with configurable expiration

## Common Tasks

### Adding a New OAuth Provider
1. Add client ID/secret to .env: `PROVIDER_CLIENT_ID`, `PROVIDER_CLIENT_SECRET`
2. Update src/lib/auth.ts `socialProviders` section
3. Better Auth will automatically create routes

### Modifying Email Templates
1. For custom HTML: Edit src/lib/email.ts functions
2. For MailerSend templates: Set template IDs in .env
3. Templates support dynamic variables via `dynamicTemplateData`

### Testing Email Locally
1. Use src/test-email.ts script
2. Or set `MAILERSEND_API_KEY=""` to see console output only
3. Better Auth will call email functions with proper URLs

### Debugging Authentication Issues
1. Check logs: `docker compose logs -f auth-api`
2. Verify database schema: `\dt auth.*` in psql
3. Ensure BETTER_AUTH_SECRET matches between auth-api and app-api
4. Check cookie domain settings for localhost vs production
5. Verify CORS origins include the requesting frontend URL

### Working with the Database
- Connection pooling configured: max 20 connections, 30s idle timeout, 2s connection timeout
- Schema is set to `auth` in connection configuration
- Better Auth auto-migrates tables on startup
- Never manually modify auth schema tables - Better Auth manages them

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
- Health checks configured
- dumb-init for proper signal handling
