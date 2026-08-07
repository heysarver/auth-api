--liquibase formatted sql

--changeset auth-api:005-add-workload-renewal-credentials context:development,production
--comment: Add opt-in DPoP-bound rotating renewal credential families without changing default workload grants

ALTER TABLE auth.workload_grants
    ADD COLUMN IF NOT EXISTS renewable BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS auth.workload_renewal_families (
    id UUID PRIMARY KEY,
    principal_id UUID NOT NULL REFERENCES auth.workload_principals(principal_id),
    cnf_jkt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS workload_renewal_families_active_principal_idx
    ON auth.workload_renewal_families (principal_id, expires_at)
    WHERE status = 'active' AND revoked_at IS NULL;

ALTER TABLE auth.workload_tokens
    ADD COLUMN IF NOT EXISTS renewal_family_id UUID REFERENCES auth.workload_renewal_families(id);

CREATE INDEX IF NOT EXISTS workload_tokens_renewal_family_idx
    ON auth.workload_tokens (renewal_family_id)
    WHERE renewal_family_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth.workload_renewal_credentials (
    id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES auth.workload_renewal_families(id),
    secret_hash CHAR(64) NOT NULL UNIQUE,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS workload_renewal_credentials_active_idx
    ON auth.workload_renewal_credentials (family_id, expires_at)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.workload_renewal_idempotency (
    family_id UUID NOT NULL REFERENCES auth.workload_renewal_families(id),
    request_key_hash CHAR(64) NOT NULL,
    credential_id UUID NOT NULL REFERENCES auth.workload_renewal_credentials(id),
    replacement_credential_id UUID NOT NULL REFERENCES auth.workload_renewal_credentials(id),
    access_token_jti UUID NOT NULL,
    access_token_issued_at BIGINT NOT NULL,
    access_token_expires_at BIGINT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (family_id, request_key_hash)
);

CREATE INDEX IF NOT EXISTS workload_renewal_idempotency_expiry_idx
    ON auth.workload_renewal_idempotency (expires_at);
