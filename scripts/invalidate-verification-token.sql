-- Invalidate verification token for testing expired links
-- Run this from psql or via docker exec

-- Option 1: Delete a specific verification token
DELETE FROM auth.verifications
WHERE identifier = 'user@example.com';

-- Option 2: Expire a token by setting expiresAt to the past
UPDATE auth.verifications
SET "expiresAt" = NOW() - INTERVAL '1 hour'
WHERE identifier = 'user@example.com';

-- Option 3: View all verification tokens (for debugging)
SELECT
    identifier,
    value,
    "expiresAt",
    "createdAt"
FROM auth.verifications
ORDER BY "createdAt" DESC;

-- Option 4: Delete all expired tokens
DELETE FROM auth.verifications
WHERE "expiresAt" < NOW();

-- Option 5: Get verification token for a specific user
SELECT v.*
FROM auth.verifications v
WHERE v.identifier = 'user@example.com';
