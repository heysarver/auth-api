import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../migrations/changelog/changes/auth/004-create-workload-identity-tables.sql", import.meta.url),
  "utf8",
);
const changelog = readFileSync(
  new URL("../../../migrations/changelog/db.changelog-master.yaml", import.meta.url),
  "utf8",
);
const renewalMigration = readFileSync(
  new URL("../../../migrations/changelog/changes/auth/005-add-workload-renewal-credentials.sql", import.meta.url),
  "utf8",
);
const workloadChangeSet = changelog.slice(changelog.indexOf("id: auth-004"));

describe("generic workload principal migration", () => {
  it.each([
    "auth.workload_principals",
    "auth.workload_grants",
    "auth.workload_tokens",
    "auth.workload_dpop_replays",
  ])("creates and has an executable changelog rollback for %s", (table) => {
    expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(workloadChangeSet).toContain(`DROP TABLE IF EXISTS ${table}`);
  });

  it("enforces issuer-owned principals, one-time grants, replay uniqueness, and soft revocation", () => {
    expect(migration).toContain("secret_hash CHAR(64) NOT NULL UNIQUE");
    expect(migration).toContain("principal_id UUID PRIMARY KEY");
    expect(migration).toContain("REFERENCES auth.workload_principals(principal_id)");
    expect(migration).toContain("PRIMARY KEY (cnf_jkt, proof_jti)");
    expect(migration).toContain("revoked_at TIMESTAMPTZ");
    expect(migration).not.toMatch(/worker_id|tenant_id|agent_id|enrollment_id/);
  });
});

describe("renewable workload credential migration", () => {
  it("is additive, opt-in, hashed, family-bound, and rollback-safe", () => {
    expect(renewalMigration).toContain("ADD COLUMN IF NOT EXISTS renewable BOOLEAN NOT NULL DEFAULT FALSE");
    expect(renewalMigration).toContain("auth.workload_renewal_families");
    expect(renewalMigration).toContain("auth.workload_renewal_credentials");
    expect(renewalMigration).toContain("secret_hash CHAR(64) NOT NULL UNIQUE");
    expect(renewalMigration).toContain("renewal_family_id UUID REFERENCES");
    expect(renewalMigration).not.toMatch(/raw_(credential|token|grant)|private_key|dpop_proof/i);
    expect(changelog).toContain("id: auth-005");
    expect(changelog).toContain("ALTER TABLE auth.workload_tokens DROP COLUMN IF EXISTS renewal_family_id");
  });

  it("persists only minimal two-minute replay reconstruction fields", () => {
    expect(renewalMigration).toContain("request_key_hash CHAR(64) NOT NULL");
    expect(renewalMigration).toContain("replacement_credential_id UUID NOT NULL");
    expect(renewalMigration).toContain("access_token_jti UUID NOT NULL");
    expect(renewalMigration).not.toContain("response_payload");
  });
});
