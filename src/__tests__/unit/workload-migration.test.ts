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
