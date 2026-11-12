#!/usr/bin/env bash
#
# verify-isolated-as-flow.sh — reproduce the Boothwright dedicated
# authorization-server verification against an ISOLATED PostgreSQL.
#
#   * starts throwaway postgres + redis containers (names prefixed as-verify-)
#   * applies the shared base migrations + the opt-in MarketKit provider schema (007)
#     + the opt-in base-schema alignment (008)
#   * builds the OPTIONAL extension image (Dockerfile.marketkit)
#   * boots the container against the isolated DB with MARKETKIT_OAUTH_ENABLED=true
#   * asserts /health, the discovery document, and a full live signed-token flow
#     (sign-up -> authorize/S256 PKCE -> token -> JWKS-verified identity)
#
# No production database, no live Google credentials, no live users. Every value
# below is a throwaway fixture. Requires: docker, node>=20, curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PG=as-verify-pg
REDIS=as-verify-redis
APP=as-verify-app
IMAGE=marketkit/auth-api:boothwright-as-verify
APP_PORT="${APP_PORT:-13002}"

cleanup() { docker rm -f "$APP" "$REDIS" "$PG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== 1. isolated postgres + redis =="
docker rm -f "$APP" "$REDIS" "$PG" >/dev/null 2>&1 || true
docker run -d --name "$PG" -e POSTGRES_PASSWORD=verify -e POSTGRES_USER=postgres -e POSTGRES_DB=authdb postgres:16-alpine >/dev/null
docker run -d --name "$REDIS" redis:7-alpine >/dev/null
# Wait for a REAL query to succeed: pg_isready briefly reports ready during the
# initdb restart window ("database system is shutting down").
for i in $(seq 1 60); do
  docker exec "$PG" psql -U postgres -d authdb -tAc "SELECT 1" >/dev/null 2>&1 && break
  sleep 1
done
PGIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG")
RDIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$REDIS")
PGC="docker exec -i $PG psql -U postgres -d authdb -v ON_ERROR_STOP=1"

echo "== 2. apply schema (shared base + opt-in provider + opt-in align) =="
$PGC -c "CREATE SCHEMA IF NOT EXISTS auth;" >/dev/null
$PGC -f - < migrations/changelog/changes/auth/001-create-auth-tables.sql >/dev/null
$PGC -f - < migrations/changelog/changes/auth/002-create-jwks-table.sql >/dev/null
$PGC -f - < migrations/changelog/changes/auth/003-add-user-disable-state.sql >/dev/null
$PGC -f - < migrations/changelog/changes/auth/007-create-oauth-provider-tables.sql >/dev/null
$PGC -f - < migrations/changelog/changes/auth/008-align-better-auth-177-schema.sql >/dev/null
$PGC -c "select table_name from information_schema.tables where table_schema='auth' order by 1;"

echo "== 3. build extension image =="
docker build -f Dockerfile.marketkit -t "$IMAGE" .

echo "== 4. boot container (extension ON) =="
docker run -d --name "$APP" -p "${APP_PORT}:3002" \
  -e NODE_ENV=production -e POSTGRES_POOL_MAX=10 \
  -e DATABASE_URL="postgresql://postgres:verify@${PGIP}:5432/authdb?schema=auth" \
  -e REDIS_URL="redis://${RDIP}:6379/1" \
  -e BETTER_AUTH_URL="http://localhost:${APP_PORT}" \
  -e BETTER_AUTH_SECRET="verify-secret-key-minimum-32-characters-long-x" \
  -e REQUIRE_EMAIL_VERIFICATION=false \
  -e MARKETKIT_OAUTH_ENABLED=true \
  -e MARKETKIT_OAUTH_CLIENT_ID="marketkit-mcp" \
  -e MARKETKIT_OAUTH_CLIENT_NAME="MarketKit MCP" \
  -e MARKETKIT_OAUTH_RESOURCE="https://mcp.marketkit.example" \
  -e MARKETKIT_OAUTH_REDIRECT_URIS="https://mcp.marketkit.example/callback" \
  -e MARKETKIT_OAUTH_ALLOWED_ORIGINS="https://mcp.marketkit.example" \
  -e MARKETKIT_OAUTH_SCOPES="mcp:tools,mcp:artifacts:read,offline_access" \
  -e MARKETKIT_OAUTH_CONSENT_PAGE="/consent" \
  -e MARKETKIT_OAUTH_LOGIN_PAGE="/login" \
  "$IMAGE" >/dev/null
sleep 8

echo "== 5. health + discovery =="
curl -sf "http://localhost:${APP_PORT}/health" && echo
curl -sf "http://localhost:${APP_PORT}/.well-known/oauth-authorization-server" | head -c 400 && echo

echo "== 6. seed the configured client (resource was auto-seeded at boot) =="
$PGC -c "INSERT INTO auth.\"oauthClient\" (\"id\",\"clientId\",\"name\",\"redirectUris\",\"scopes\",\"requirePKCE\",\"skipConsent\",\"tokenEndpointAuthMethod\",\"grantTypes\",\"responseTypes\",\"disabled\",\"createdAt\",\"updatedAt\") VALUES ('mkc-1','marketkit-mcp','MarketKit MCP','[\"https://mcp.marketkit.example/callback\"]'::jsonb,'[\"mcp:tools\",\"mcp:artifacts:read\",\"offline_access\"]'::jsonb,TRUE,TRUE,'none','[\"authorization_code\",\"refresh_token\"]'::jsonb,'[\"code\"]'::jsonb,FALSE,now(),now()) ON CONFLICT (\"clientId\") DO NOTHING;"
$PGC -c "INSERT INTO auth.\"oauthClientResource\" (\"id\",\"clientId\",\"resourceId\",\"createdAt\") SELECT 'mkcr-1','marketkit-mcp','https://mcp.marketkit.example',now() WHERE EXISTS (SELECT 1 FROM auth.\"oauthResource\" WHERE \"identifier\"='https://mcp.marketkit.example') ON CONFLICT DO NOTHING;"

echo "== 7. live signed-token flow =="
BASE="http://localhost:${APP_PORT}" node live-container-flow.mjs

echo "ALL CHECKS PASSED"
