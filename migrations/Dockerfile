# Liquibase Migration Image for Auth API
# This image contains only the migration files and runs Liquibase update

FROM liquibase/liquibase:4.30-alpine

# Switch to root to install packages
USER root

# Install PostgreSQL client for schema creation
RUN apk add --no-cache postgresql-client

# Switch back to liquibase user
USER liquibase

# Set working directory
WORKDIR /liquibase/changelog

# Copy migration files (build context is migrations/ directory)
COPY changelog/ ./
COPY liquibase.properties.example ./liquibase.properties.template

# Copy entrypoint script (already executable from host)
COPY docker-entrypoint.sh /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
