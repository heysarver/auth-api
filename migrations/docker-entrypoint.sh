#!/bin/sh
set -e

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
