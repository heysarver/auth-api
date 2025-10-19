--liquibase formatted sql

--changeset auth-api:003-create-jwks-table context:development,production
--comment: Create JWKS table for JWT plugin

CREATE TABLE IF NOT EXISTS auth.jwks (
    id VARCHAR(255) PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--rollback DROP TABLE IF EXISTS auth.jwks;
