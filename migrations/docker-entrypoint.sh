#!/bin/sh
set -eu

umask 077
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

cat > /tmp/liquibase-bootstrap.properties <<PROPS
driver=org.postgresql.Driver
url=jdbc:postgresql://${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}
username=${POSTGRES_USER}
password=${POSTGRES_PASSWORD}
logLevel=INFO
PROPS

echo "Waiting for PostgreSQL to be ready..."
until liquibase --defaults-file=/tmp/liquibase-bootstrap.properties \
  execute-sql --sql="SELECT 1;" >/dev/null 2>&1; do
  echo "PostgreSQL not ready, retrying in 2s..."
  sleep 2
done
echo "PostgreSQL is ready"

echo "Creating PostgreSQL schemas..."
liquibase --defaults-file=/tmp/liquibase-bootstrap.properties \
  execute-sql --sql="CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS liquibase;"
rm -f /tmp/liquibase-bootstrap.properties

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
