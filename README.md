# Auth API

A production-ready authentication service built with Express and better-auth, providing secure user authentication with email/password and OAuth social providers.

## 🛠 Tech Stack

- **Framework**: Express 5
- **Authentication**: better-auth
- **Database**: PostgreSQL (auth schema)
- **Language**: TypeScript
- **Runtime**: Node.js 24

## 📦 Features

- Email/password authentication
- GitHub OAuth integration
- JWT-based sessions
- Rate limiting
- CORS support
- Secure cookie handling
- PostgreSQL with separate auth schema

## 🚀 Getting Started

### Prerequisites

- Node.js 24+
- PostgreSQL 17+
- GitHub OAuth App (for social login)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Copy and configure environment variables:
```bash
cp .env.example .env
```

3. Copy and configure Liquibase properties:
```bash
cp migrations/liquibase.properties.example migrations/liquibase.properties
```

4. Generate a secure secret key:
```bash
# Generate a cryptographically secure secret (min 32 characters)
openssl rand -base64 32
```

5. Configure your `.env` file with:
   - `DATABASE_URL` - PostgreSQL connection string (format: `postgresql://user:password@host:port/database?schema=auth`)
   - `BETTER_AUTH_SECRET` - Use the generated secret key from step 4 (min 32 characters)
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` - GitHub OAuth credentials (optional)
   - `SENDGRID_API_KEY` - Email service credentials (optional for development)
   - `FRONTEND_URL` - Your frontend URL for CORS (default: `http://localhost:5173`)

6. Configure `migrations/liquibase.properties` with:
   - `url` - JDBC connection URL (format: `jdbc:postgresql://host:port/database`)
   - `username` - Database username
   - `password` - Database password

   **Note**: This file is gitignored as it contains database credentials. Never commit it to version control.

### Database Setup

The auth API uses a separate `auth` schema in PostgreSQL. Database migrations are managed by Liquibase:

1. Navigate to the migrations folder:
```bash
cd ../migrations
```

2. Run Liquibase migrations:
```bash
liquibase update -Dcontexts=development
```

Note: Better-auth will also automatically create/update its required tables on first run.

### Development

```bash
# Run in development mode with hot reload
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

## 🔗 API Endpoints

### Subdomain Routing Architecture

**Production**: `https://auth.domain.com`
**Staging**: `https://auth-staging.domain.com`
**Local Development**: `http://localhost:3002`

All auth routes are at the **root path** (no `/api/auth/` prefix):

- `POST /sign-up` - Register new user
- `POST /sign-in` - Sign in with email/password
- `POST /sign-out` - Sign out user
- `GET /session` - Get current session
- `GET /github` - GitHub OAuth flow
- `GET /callback/github` - GitHub OAuth callback
- `GET /jwks` - JWKS endpoint for JWT validation
- `POST /token/introspect` - Machine-authenticated bearer-token activity check

### Utility Routes

- `GET /health` - Health check endpoint
- `GET /` - API info

## 🔒 Security Features

- Helmet.js for security headers
- Rate limiting (100 requests per 15 minutes)
- CORS configuration for trusted origins
- Secure cookie settings in production
- Password hashing with bcrypt
- JWT token signing

## 🐳 Docker Support

### Development

```bash
docker build -f Dockerfile.dev -t auth-api:dev .
docker run -p 3002:3002 --env-file .env auth-api:dev
```

### Production

The production Dockerfile uses multi-stage builds for optimal image size and security:

```bash
# Build production image
docker build -t auth-api:latest .

# Run production container
docker run -p 3002:3002 --env-file .env auth-api:latest
```

**Production Features:**
- Multi-stage build for minimal image size
- Non-root user for enhanced security
- Health checks for container orchestration
- Signal handling with dumb-init
- Production-only dependencies

## 📝 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3002 |
| `NODE_ENV` | Environment | development |
| `DATABASE_URL` | PostgreSQL connection string | - |
| `BETTER_AUTH_SECRET` | Secret for JWT signing (min 32 chars) | - |
| `BETTER_AUTH_URL` | Base URL for auth (subdomain: auth.domain.com) | http://localhost:3002 |
| `JWT_AUDIENCE` | Exact JWT audience required by relying services | BETTER_AUTH_URL |
| `TOKEN_INTROSPECTION_CLIENT_ID` | Non-secret audit label for the machine client | nebulaios |
| `TOKEN_INTROSPECTION_BEARER_TOKEN` | Secret-manager-provisioned credential for `/token/introspect` | - |
| `TOKEN_INTROSPECTION_RATE_LIMIT_MAX` | Per-minute introspection request limit | 120 |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID | - |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | - |
| `FRONTEND_URL` | Frontend URL for CORS (domain.com) | http://localhost:5173 |
| `API_URL` | Core API URL for CORS (api.domain.com) | http://localhost:3001 |
| `SESSION_EXPIRES_IN` | Session duration in seconds | 86400 |
| `SESSION_UPDATE_AGE` | Session refresh interval | 3600 |

### Token introspection for NebulaiOS

The introspection URL is the configured issuer with the root path appended:

```text
POST <BETTER_AUTH_URL without a trailing slash>/token/introspect
```

Do not use `/api/auth/token/introspect` or append the route to the JWKS URL. The
machine client sends its dedicated, externally provisioned credential as
`Authorization: Bearer <TOKEN_INTROSPECTION_BEARER_TOKEN>` and JSON body
`{"token":"<original bearer JWT>"}`. Configure NebulaiOS's expected audience
to exactly match `JWT_AUDIENCE`; the intended control-plane value is
`nebulaios-control-plane`. Generate a random machine credential of at least 32
characters and provision the same value to both services through their secret
managers.

Bearer JWTs use the PostgreSQL Better Auth session ID as `jti`. PostgreSQL is
the durable activity authority while Redis remains secondary session storage.
Sign-out, explicit session revocation, and password reset remove affected
session records. Setting `auth.users.disabled = TRUE` also deletes that user's
sessions through a database trigger, while application and database guards
reject new sessions until the user is re-enabled. Later re-enablement therefore
cannot reactivate old tokens. Revoked rows are deleted; active rows remain until
their configured session expiry. Positive introspection responses may be cached
for at most 30 seconds; inactive and error responses are non-cacheable.

Rollout is fail-closed: JWTs issued before this feature lack a session `jti`,
and Redis-only sessions are not backfilled into PostgreSQL. Users must
reauthenticate to obtain an introspectable bearer token after deployment.

## 🧪 Testing

```bash
# Run tests
npm test

# Test coverage
npm run test:coverage
```

## 🔄 Using as a Git Submodule

This repository is designed to work as a standalone service or as a Git submodule in a larger monorepo.

### Initial Setup as Submodule

When first cloning a parent repository that includes this as a submodule:

```bash
# In the parent repository
git submodule update --init --recursive
cd auth-api
npm install
cp .env.example .env
cp migrations/liquibase.properties.example migrations/liquibase.properties
# Configure both files with your credentials
```

### Working with Submodules

```bash
# Update submodule to latest commit
git submodule update --remote auth-api

# Commit submodule changes in parent repo
git add auth-api
git commit -m "Update auth-api submodule"
```

### Configuration Files

The following files are **gitignored** and must be configured locally:
- `.env` - Application environment variables
- `migrations/liquibase.properties` - Database migration credentials

These files contain project-specific credentials and should never be committed to version control.

## 📄 License

MIT License - See LICENSE file for details
 
