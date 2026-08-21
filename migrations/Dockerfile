# Liquibase Migration Image for Auth API
# This image contains only the migration files and runs Liquibase update

FROM liquibase/liquibase:4.30-alpine

# Liquibase includes the PostgreSQL JDBC driver used by the entrypoint for
# readiness checks, schema creation, and migrations. Avoid an extra apk fetch
# so this image remains deterministic when Alpine mirrors are unavailable.
USER liquibase

# Set working directory
WORKDIR /liquibase/changelog

# Copy migration files (build context is migrations/ directory)
COPY changelog/ ./
COPY liquibase.properties.example ./liquibase.properties.template

# Copy entrypoint script (already executable from host)
COPY docker-entrypoint.sh /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
