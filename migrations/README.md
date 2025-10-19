# Auth API Database Migrations

This directory contains Liquibase migrations for the auth-api service, managing the `auth` schema in PostgreSQL.

## Overview

The auth-api uses Liquibase to manage database schema migrations for authentication-related tables:
- `auth.users` - User accounts
- `auth.sessions` - User sessions
- `auth.accounts` - OAuth provider accounts
- `auth.verifications` - Email verification and password reset tokens
- `auth.jwks` - JSON Web Key Sets for JWT signing

## Quick Start

### Prerequisites
- Docker and Docker Compose installed
- PostgreSQL database running (handled by docker-compose)
- `.env` file configured with database credentials

### Running Migrations

**As Part of Parent Project:**

From the parent project's root directory:

```bash
# Run auth schema migrations
docker compose --profile migrate up liquibase-auth

# Check migration status
docker compose --profile migrate run --rm liquibase-auth status --verbose

# Preview SQL without applying
docker compose --profile migrate run --rm liquibase-auth updateSQL

# Rollback last migration
docker compose --profile migrate run --rm liquibase-auth rollback-count 1
```

**Standalone Usage:**

When using auth-api as a standalone service:

1. Create the network: `docker network create auth-network`
2. Copy the override file: `cp docker-compose.override.yaml.example docker-compose.override.yaml`
3. Ensure PostgreSQL is accessible
4. Run migrations from the `auth-api` directory:

```bash
# Run all pending migrations
docker compose --profile migrate up liquibase-auth

# Check migration status
docker compose --profile migrate run --rm liquibase-auth status --verbose
```

### Running Migrations Locally

If you have Liquibase installed locally:

```bash
cd migrations

# Apply migrations
liquibase update

# Check status
liquibase status --verbose

# Rollback
liquibase rollback-count 1
```

## Directory Structure

```
migrations/
├── liquibase.properties          # Liquibase configuration
├── changelog/
│   ├── db.changelog-master.yaml  # Master changelog file
│   └── changes/
│       └── auth/                 # Auth schema migrations
│           ├── 002-create-auth-tables.sql
│           └── 003-create-jwks-table.sql
└── README.md                     # This file
```

## Configuration

### liquibase.properties

The `liquibase.properties` file contains the database connection settings:
- **defaultSchemaName**: `auth` - All tables are created in the auth schema
- **liquibaseSchemaName**: `liquibase` - Liquibase tracking tables
- **contexts**: `development` - Default context for migrations

### Environment Variables

The Liquibase service reads these from your `.env` file:
- `POSTGRES_HOST` - Database host (default: postgres)
- `POSTGRES_PORT` - Database port (default: 5432)
- `POSTGRES_USER` - Database username (default: postgres)
- `POSTGRES_PASSWORD` - Database password (default: postgres)
- `POSTGRES_DB` - Database name (default: authdb)

## Creating New Migrations

1. Create a new SQL file in `changelog/changes/auth/`:
   ```sql
   --liquibase formatted sql

   --changeset author:unique-id context:development
   --comment: Description of the change

   -- Your SQL here

   --rollback SQL to undo the change
   ```

2. Add a reference to the new file in `db.changelog-master.yaml`:
   ```yaml
   - changeSet:
       id: auth-004
       author: system
       context: development
       comment: Your migration description
       changes:
         - sqlFile:
             path: changes/auth/004-your-migration.sql
             relativeToChangelogFile: true
             splitStatements: true
             stripComments: true
   ```

3. Run the migration:
   ```bash
   docker compose --profile migrate up liquibase
   ```

## Best Practices

1. **Never modify existing migrations** - Create new ones instead
2. **Always include rollback commands** - Use `--rollback` comments in SQL files
3. **Test migrations locally first** - Use `updateSQL` to preview changes
4. **Use descriptive changeset IDs** - Follow the `auth-XXX` pattern
5. **Include comments** - Explain what the migration does and why
6. **Use contexts** - Separate dev, test, and production migrations if needed

## Integration with Better Auth

The migrations in this directory create the tables that Better Auth expects:
- Table names use **plural form** (users, sessions, accounts, verifications)
- Column names use **camelCase** per Better Auth conventions
- Schema is explicitly set to `auth`

Better Auth will not auto-create these tables if they already exist, so these migrations ensure:
- Consistent schema across environments
- Version control for database structure
- Ability to rollback changes if needed

## Troubleshooting

### Migration fails with "relation already exists"
- Check if Better Auth already created the tables
- Use `DROP TABLE IF EXISTS` in rollback, then run rollback and re-apply

### Cannot connect to database
- Ensure PostgreSQL is running: `docker compose ps postgres`
- Check `.env` file has correct credentials
- Verify network: `docker network ls | grep auth-network`

### Liquibase tracking tables in wrong schema
- Check `liquibaseSchemaName` in `liquibase.properties`
- Default is `liquibase` schema, separate from `auth` and `app`

### Changes not being applied
- Check migration status: `liquibase status --verbose`
- Ensure changeset ID is unique
- Check contexts match (development, production, etc.)

## Standalone Usage

When auth-api becomes a standalone repository:

1. This migrations directory is self-contained
2. Run migrations using the docker-compose service
3. No dependency on the main project's migrations
4. All auth schema changes are tracked here

## Additional Resources

- [Liquibase Documentation](https://docs.liquibase.com/)
- [Better Auth Database Schema](https://www.better-auth.com/docs/concepts/database)
- [PostgreSQL Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html)
