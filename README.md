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

### Authentication Routes

All auth routes are prefixed with `/api/auth/`:

- `POST /api/auth/sign-up` - Register new user
- `POST /api/auth/sign-in` - Sign in with email/password
- `POST /api/auth/sign-out` - Sign out user
- `GET /api/auth/session` - Get current session
- `GET /api/auth/github` - GitHub OAuth flow
- `GET /api/auth/callback/github` - GitHub OAuth callback

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
| `BETTER_AUTH_URL` | Base URL for auth | http://localhost:3002 |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID | - |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | - |
| `FRONTEND_URL` | Frontend URL for CORS | http://localhost:5173 |
| `SESSION_EXPIRES_IN` | Session duration in seconds | 86400 |
| `SESSION_UPDATE_AGE` | Session refresh interval | 3600 |

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
