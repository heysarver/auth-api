#!/bin/sh
set -e

# Create liquibase.properties from environment variables
cat > /liquibase/changelog/liquibase.properties <<PROPS
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
liquibase --defaults-file=/liquibase/changelog/liquibase.properties update

echo "Migrations completed successfully!"
