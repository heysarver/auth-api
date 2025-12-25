# Valkey Sentinel Connection Fix

## Problem
- auth-api was connecting to `localhost:6379` instead of Valkey Sentinel service
- Connection errors: `ECONNREFUSED ::1:6379, 127.0.0.1:6379`
- JWKS endpoint returning HTTP 500: `https://staging.feedvalue.com/api/auth/.well-known/jwks.json`

## Root Cause
- auth-api Redis client was not configured to use Sentinel mode
- Better-auth JWT plugin requires Redis/Valkey for JWKS caching
- Connection failure caused JWKS endpoint to fail

## Solution
Implemented Sentinel-aware ioredis configuration with automatic mode detection:
- **Development**: Uses standalone Redis connection (`REDIS_URL`)
- **Production/Staging**: Uses Sentinel mode (`VALKEY_SENTINEL_HOST`)

## Changes Made

### 1. Updated `src/lib/redis.ts`
- Added Sentinel connection configuration
- Automatic mode detection based on `VALKEY_SENTINEL_HOST` environment variable
- Sentinel retry strategy with exponential backoff
- Enhanced logging to show connection mode

### 2. Updated `.env.example`
- Documented new Sentinel environment variables:
  - `VALKEY_SENTINEL_HOST` - Sentinel service hostname
  - `VALKEY_SENTINEL_PORT` - Sentinel port (default: 26379)
  - `VALKEY_SENTINEL_MASTER_NAME` - Master group name (default: mymaster)

### 3. Updated `helm/feedvalue/values-staging.yaml`
- Added Sentinel environment variables to auth-api deployment:
  ```yaml
  - name: VALKEY_SENTINEL_HOST
    value: "feedvalue-staging-valkey"
  - name: VALKEY_SENTINEL_PORT
    value: "26379"
  - name: VALKEY_SENTINEL_MASTER_NAME
    value: "mymaster"
  ```

## Deployment Steps

### 1. Commit and Push Changes
```bash
cd /Users/asarver/workspace/github_sarverenterprises/feedvalue/auth-api
git add src/lib/redis.ts .env.example
git commit -m "fix: configure Valkey Sentinel connection for HA mode

- Add Sentinel-aware ioredis configuration
- Support both Sentinel (production) and standalone (dev) modes
- Fix JWKS endpoint 500 error caused by Redis connection failure
- Add connection mode logging for debugging

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
git push
```

### 2. Update Helm Values
```bash
cd /Users/asarver/workspace/github_sarverenterprises/feedvalue
git add helm/feedvalue/values-staging.yaml
git commit -m "fix: add Valkey Sentinel env vars to auth-api staging config

- Configure VALKEY_SENTINEL_HOST, PORT, and MASTER_NAME
- Enable Sentinel mode for high availability
- Fix auth-api Redis connection errors

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
git push
```

### 3. Deploy to Staging
```bash
# Rebuild and push auth-api image (if using CI/CD, this happens automatically)
# OR manually:
cd /Users/asarver/workspace/github_sarverenterprises/feedvalue/auth-api
docker build -t feedvalue-staging/auth-api:staging-latest .
docker push feedvalue-staging/auth-api:staging-latest

# Upgrade Helm release
cd /Users/asarver/workspace/github_sarverenterprises/feedvalue
helm upgrade feedvalue-staging ./helm/feedvalue \
  -f ./helm/feedvalue/values-staging.yaml \
  --namespace feedvalue-staging
```

### 4. Verify Deployment
```bash
# Check auth-api pod logs for Sentinel connection
kubectl logs -n feedvalue-staging -l app=auth-api --tail=50 | grep -E "Valkey|Redis"

# Expected output:
# 📡 Using Valkey Sentinel mode: feedvalue-staging-valkey:26379 (master: mymaster)
# ✅ Redis connected

# Test JWKS endpoint
curl -s https://staging.feedvalue.com/api/auth/.well-known/jwks.json | jq .

# Expected: HTTP 200 with valid JWKS JSON response
```

## Testing Checklist
- [x] Unit tests pass (57/57 tests)
- [ ] auth-api starts without Redis connection errors
- [ ] JWKS endpoint returns HTTP 200 with valid JSON
- [ ] Sign-up flow works
- [ ] Sign-in flow works
- [ ] Email verification works
- [ ] Session persistence works

## Rollback Plan
If deployment fails:
```bash
# Revert Helm values
git revert HEAD
helm upgrade feedvalue-staging ./helm/feedvalue \
  -f ./helm/feedvalue/values-staging.yaml \
  --namespace feedvalue-staging

# OR: Add REDIS_URL as fallback
kubectl set env deployment/feedvalue-staging-auth-api \
  REDIS_URL=redis://feedvalue-staging-valkey:6379 \
  -n feedvalue-staging
```

## Notes
- Sentinel configuration is backward compatible (falls back to REDIS_URL if VALKEY_SENTINEL_HOST is not set)
- No changes needed for local development (still uses standalone Redis)
- Sentinel mode provides automatic failover and high availability
- Connection retry strategies ensure resilience during Sentinel failover events
