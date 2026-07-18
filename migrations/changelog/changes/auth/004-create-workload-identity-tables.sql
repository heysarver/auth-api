--liquibase formatted sql

--changeset auth-api:004-create-workload-identity-tables context:development,production
--comment: Add generic workload principals, one-time grants, issued-token state, and DPoP replay protection

CREATE TABLE IF NOT EXISTS auth.workload_principals (
    principal_id UUID PRIMARY KEY,
    cnf_jkt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth.workload_grants (
    id UUID PRIMARY KEY,
    secret_hash CHAR(64) NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK (mode IN ('create', 'rotate')),
    principal_id UUID NOT NULL,
    cnf_jkt TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS workload_grants_active_idx
    ON auth.workload_grants (principal_id, expires_at)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.workload_tokens (
    jti UUID PRIMARY KEY,
    principal_id UUID NOT NULL REFERENCES auth.workload_principals(principal_id),
    cnf_jkt TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS workload_tokens_principal_active_idx
    ON auth.workload_tokens (principal_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.workload_dpop_replays (
    cnf_jkt TEXT NOT NULL,
    proof_jti TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (cnf_jkt, proof_jti)
);

CREATE INDEX IF NOT EXISTS workload_dpop_replays_expiry_idx
    ON auth.workload_dpop_replays (expires_at);
