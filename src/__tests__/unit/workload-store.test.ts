import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPostgresWorkloadStore } from "../../lib/workload-store.js";
import type { WorkloadTokenClaims } from "../../lib/workload-token.js";

const grantInput = {
  mode: "enroll" as const,
  workerId: "worker-1",
  tenantId: "tenant-1",
  agentId: "agent-1",
  enrollmentId: "enrollment-1",
  jkt: "A".repeat(43),
};

const claims: WorkloadTokenClaims = {
  sub: grantInput.workerId,
  iss: "https://auth.example.test",
  aud: "worker-audience",
  tenant_id: grantInput.tenantId,
  agent_id: grantInput.agentId,
  enrollment_id: grantInput.enrollmentId,
  jti: "11111111-1111-4111-8111-111111111111",
  iat: 1_800_000_000,
  exp: 1_800_000_300,
  token_use: "workload",
  cnf: { jkt: grantInput.jkt },
};

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function databaseWithClient(queryImplementation: (sql: string, params?: unknown[]) => Promise<unknown>) {
  const client = {
    query: vi.fn(queryImplementation),
    release: vi.fn(),
  };
  return {
    database: {
      connect: vi.fn(async () => client),
      query: vi.fn(queryImplementation),
    },
    client,
  };
}

describe("PostgreSQL workload store", () => {
  it("stores only a digest of a one-time grant", async () => {
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("SELECT status")) return result();
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    const created = await store.createGrant(grantInput, 300);

    expect(created.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const insertCall = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO auth.workload_enrollment_grants"));
    expect(insertCall).toBeDefined();
    const parameters = insertCall?.[1] as unknown[];
    expect(parameters).not.toContain(created.grant);
    expect(parameters).toContain(createHash("sha256").update(created.grant).digest("hex"));
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim())).toContain("COMMIT");
  });

  it("atomically consumes a grant, stores replay state, activates identity, and inserts jti", async () => {
    const grant = "one-time-secret";
    const grantRow = {
      mode: "enroll",
      workerId: grantInput.workerId,
      tenantId: grantInput.tenantId,
      agentId: grantInput.agentId,
      enrollmentId: grantInput.enrollmentId,
      cnfJkt: grantInput.jkt,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      revokedAt: null,
    };
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("FROM auth.workload_enrollment_grants") && sql.includes("FOR UPDATE")) return result([grantRow]);
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await store.consumeGrantAndIssue(grant, {
      jkt: grantInput.jkt,
      proofJti: "proof-1",
      expiresAt: new Date(Date.now() + 60_000),
    }, claims);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_dpop_replays"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_identities"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_tokens"))).toBe(true);
    expect(statements.some((sql) => sql.trim() === "COMMIT")).toBe(true);
  });

  it("reads only an active, unconsumed grant", async () => {
    const grantRow = {
      mode: "enroll",
      workerId: grantInput.workerId,
      tenantId: grantInput.tenantId,
      agentId: grantInput.agentId,
      enrollmentId: grantInput.enrollmentId,
      cnfJkt: grantInput.jkt,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      revokedAt: null,
    };
    const query = vi.fn(async () => result([grantRow]));
    const store = createPostgresWorkloadStore({ query } as never);
    await expect(store.readGrant("one-time-secret")).resolves.toMatchObject(grantInput);

    query.mockResolvedValue(result([{ ...grantRow, consumedAt: new Date() }]));
    await expect(store.readGrant("one-time-secret")).rejects.toThrow("invalid_grant");
  });

  it("creates a rotation grant only for the same active identity binding", async () => {
    const rotation = { ...grantInput, mode: "rotate" as const, jkt: "B".repeat(43) };
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("SELECT status")) {
        return result([{
          status: "active",
          workerId: grantInput.workerId,
          tenantId: grantInput.tenantId,
          agentId: grantInput.agentId,
        }]);
      }
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await expect(store.createGrant(rotation, 300)).resolves.toMatchObject(rotation);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE auth.workload_enrollment_grants"))).toBe(true);
  });

  it("rotates the identity key and revokes prior tokens during grant exchange", async () => {
    const rotatedClaims = { ...claims, cnf: { jkt: "B".repeat(43) } };
    const grantRow = {
      mode: "rotate",
      workerId: grantInput.workerId,
      tenantId: grantInput.tenantId,
      agentId: grantInput.agentId,
      enrollmentId: grantInput.enrollmentId,
      cnfJkt: rotatedClaims.cnf.jkt,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      revokedAt: null,
    };
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("FROM auth.workload_enrollment_grants") && sql.includes("FOR UPDATE")) return result([grantRow]);
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await store.consumeGrantAndIssue("rotation-grant", {
      jkt: rotatedClaims.cnf.jkt,
      proofJti: "rotation-proof",
      expiresAt: new Date(Date.now() + 60_000),
    }, rotatedClaims);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("UPDATE auth.workload_identities"))).toBe(true);
    expect(statements.some((sql) => sql.includes("revoked_reason = 'key_rotated'"))).toBe(true);
  });

  it("rolls back a replayed proof before issuing a second token", async () => {
    const grantRow = {
      mode: "enroll",
      workerId: grantInput.workerId,
      tenantId: grantInput.tenantId,
      agentId: grantInput.agentId,
      enrollmentId: grantInput.enrollmentId,
      cnfJkt: grantInput.jkt,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      revokedAt: null,
    };
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("FROM auth.workload_enrollment_grants") && sql.includes("FOR UPDATE")) return result([grantRow]);
      if (sql.includes("INSERT INTO auth.workload_dpop_replays")) return result([], 0);
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);

    await expect(store.consumeGrantAndIssue("grant", {
      jkt: grantInput.jkt,
      proofJti: "proof-replay",
      expiresAt: new Date(Date.now() + 60_000),
    }, claims)).rejects.toThrow("invalid_dpop_proof");

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.trim() === "ROLLBACK")).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_tokens"))).toBe(false);
  });

  it("fails closed when persisted token state is absent", async () => {
    const query = vi.fn(async () => result([], 0));
    const store = createPostgresWorkloadStore({ query } as never);
    await expect(store.isTokenActive(claims)).resolves.toBe(false);
  });

  it("atomically renews an active token and tombstones the prior jti", async () => {
    const next = { ...claims, jti: "22222222-2222-4222-8222-222222222222" };
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("SELECT 1") && sql.includes("FOR UPDATE")) return result([{}]);
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await store.rotateToken(claims, {
      jkt: claims.cnf.jkt,
      proofJti: "renew-proof",
      expiresAt: new Date(Date.now() + 60_000),
    }, next);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("revoked_reason = 'renewed'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_tokens"))).toBe(true);
    expect(statements.some((sql) => sql.trim() === "COMMIT")).toBe(true);
  });

  it("revokes one jti idempotently", async () => {
    const { database, client } = databaseWithClient(async () => result([], 1));
    const store = createPostgresWorkloadStore(database as never);
    await expect(store.revoke({ jti: claims.jti })).resolves.toBe(1);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("operator_revoked"))).toBe(true);
  });

  it("revokes an enrollment, its tokens, and unused grants without deleting history", async () => {
    const { database, client } = databaseWithClient(async () => result([], 1));
    const store = createPostgresWorkloadStore(database as never);
    await expect(store.revoke({ enrollmentId: claims.enrollment_id })).resolves.toBe(1);
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("UPDATE auth.workload_identities"))).toBe(true);
    expect(statements.some((sql) => sql.includes("enrollment_revoked"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE auth.workload_enrollment_grants"))).toBe(true);
    expect(statements.some((sql) => /\bDELETE\b/.test(sql))).toBe(false);
  });
});
