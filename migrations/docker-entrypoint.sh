#!/bin/sh
set -e

echo "Creating PostgreSQL schemas..."

# Create schemas if they don't exist
PGPASSWORD="${POSTGRES_PASSWORD}" psql \
  -h "${POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB}" \
  -c "CREATE SCHEMA IF NOT EXISTS auth;" \
  -c "CREATE SCHEMA IF NOT EXISTS liquibase;"

echo "Schemas created successfully"

# Create liquibase.properties in /tmp (writable by non-root user)
cat > /tmp/liquibase.properties <<PROPS
driver=org.postgresql.Driver
url=jdbc:postgresql://${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}
username=${POSTGRES_USER}
password=${POSTGRES_PASSWORD}
changeLogFile=db.changelog-master.yaml
defaultSchemaName=auth
liquibaseSchemaName=liquibase
contexts=${ENVIRONMENT:-development}
logLevel=INFO
PROPS

echo "Running Liquibase migrations for auth schema..."
liquibase --defaults-file=/tmp/liquibase.properties update

echo "Migrations completed successfully!"
