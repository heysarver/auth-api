import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPostgresWorkloadStore } from "../../lib/workload-store.js";
import type { WorkloadTokenClaims } from "../../lib/workload-token.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const jkt = "A".repeat(43);
const claims: WorkloadTokenClaims = {
  sub: principalId,
  iss: "https://auth.example.test",
  aud: "workload-audience",
  jti: "22222222-2222-4222-8222-222222222222",
  iat: 1_800_000_000,
  exp: 1_800_000_300,
  token_use: "workload",
  cnf: { jkt },
};

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function databaseWithClient(queryImplementation: (sql: string, params?: unknown[]) => Promise<unknown>) {
  const client = { query: vi.fn(queryImplementation), release: vi.fn() };
  return {
    database: { connect: vi.fn(async () => client), query: vi.fn(queryImplementation) },
    client,
  };
}

function activeGrantRow(mode: "create" | "rotate" = "create", thumbprint = jkt) {
  return {
    mode,
    principalId,
    cnfJkt: thumbprint,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    revokedAt: null,
  };
}

describe("PostgreSQL generic workload store", () => {
  it("generates the principal id and stores only a digest of a one-time create grant", async () => {
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("SELECT status")) return result();
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    const created = await store.createGrant({ mode: "create", jkt }, 300);

    expect(created.principalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const insertCall = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO auth.workload_grants"));
    const parameters = insertCall?.[1] as unknown[];
    expect(parameters).not.toContain(created.grant);
    expect(parameters).toContain(createHash("sha256").update(created.grant).digest("hex"));
    expect(parameters).toContain(created.principalId);
  });

  it("creates a rotation grant only for an active issuer-owned principal", async () => {
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("SELECT status")) return result([{ status: "active" }]);
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await expect(store.createGrant({ mode: "rotate", principalId, jkt: "B".repeat(43) }, 300))
      .resolves.toMatchObject({ mode: "rotate", principalId });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE auth.workload_grants"))).toBe(true);

    client.query.mockImplementation(async (sql) => sql.includes("SELECT status")
      ? result([{ status: "revoked" }])
      : result([], 1));
    await expect(store.createGrant({ mode: "rotate", principalId, jkt }, 300)).rejects.toThrow("conflict");
  });

  it("atomically consumes a create grant, stores replay state, activates the principal, and inserts jti", async () => {
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes('principal_id AS "principalId"') && !sql.includes("FOR UPDATE")) {
        return result([{ principalId }]);
      }
      if (sql.includes("FROM auth.workload_grants") && sql.includes("FOR UPDATE")) return result([activeGrantRow()]);
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await store.consumeGrantAndIssue("one-time-secret", {
      jkt, proofJti: "proof-1", expiresAt: new Date(Date.now() + 60_000),
    }, claims);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_dpop_replays"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_principals"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_tokens"))).toBe(true);
    expect(statements.some((sql) => sql.trim() === "COMMIT")).toBe(true);
    expect(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("FOR UPDATE")));
  });

  it("reads only an active, unconsumed grant", async () => {
    const query = vi.fn(async () => result([activeGrantRow()]));
    const store = createPostgresWorkloadStore({ query } as never);
    await expect(store.readGrant("one-time-secret")).resolves.toMatchObject({ mode: "create", principalId, jkt });

    query.mockResolvedValue(result([{ ...activeGrantRow(), consumedAt: new Date() }]));
    await expect(store.readGrant("one-time-secret")).rejects.toThrow("invalid_grant");
  });

  it("rotates the principal key and revokes prior tokens during grant exchange", async () => {
    const rotatedJkt = "B".repeat(43);
    const rotatedClaims = { ...claims, cnf: { jkt: rotatedJkt } };
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes('principal_id AS "principalId"') && !sql.includes("FOR UPDATE")) {
        return result([{ principalId }]);
      }
      if (sql.includes("FROM auth.workload_grants") && sql.includes("FOR UPDATE")) {
        return result([activeGrantRow("rotate", rotatedJkt)]);
      }
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await store.consumeGrantAndIssue("rotation-grant", {
      jkt: rotatedJkt, proofJti: "rotation-proof", expiresAt: new Date(Date.now() + 60_000),
    }, rotatedClaims);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("UPDATE auth.workload_principals"))).toBe(true);
    expect(statements.some((sql) => sql.includes("revoked_reason = 'key_rotated'"))).toBe(true);
  });

  it("rolls back a replayed proof before issuing a second token", async () => {
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes('principal_id AS "principalId"') && !sql.includes("FOR UPDATE")) {
        return result([{ principalId }]);
      }
      if (sql.includes("FROM auth.workload_grants") && sql.includes("FOR UPDATE")) return result([activeGrantRow()]);
      if (sql.includes("INSERT INTO auth.workload_dpop_replays")) return result([], 0);
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await expect(store.consumeGrantAndIssue("grant", {
      jkt, proofJti: "proof-replay", expiresAt: new Date(Date.now() + 60_000),
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
    const next = { ...claims, jti: "33333333-3333-4333-8333-333333333333" };
    const { database, client } = databaseWithClient(async (sql) => {
      if (sql.includes("SELECT 1") && sql.includes("FOR UPDATE")) return result([{}]);
      return result([], 1);
    });
    const store = createPostgresWorkloadStore(database as never);
    await store.rotateToken(claims, {
      jkt, proofJti: "renew-proof", expiresAt: new Date(Date.now() + 60_000),
    }, next);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("revoked_reason = 'renewed'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO auth.workload_tokens"))).toBe(true);
  });

  it("revokes one jti idempotently", async () => {
    const { database, client } = databaseWithClient(async () => result([], 1));
    const store = createPostgresWorkloadStore(database as never);
    await expect(store.revoke({ jti: claims.jti })).resolves.toBe(1);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("operator_revoked"))).toBe(true);
  });

  it("revokes a principal, its tokens, and unused grants without deleting history", async () => {
    const { database, client } = databaseWithClient(async () => result([], 1));
    const store = createPostgresWorkloadStore(database as never);
    await expect(store.revoke({ principalId })).resolves.toBe(1);
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("UPDATE auth.workload_principals"))).toBe(true);
    expect(statements.some((sql) => sql.includes("principal_revoked"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE auth.workload_grants"))).toBe(true);
    expect(statements.some((sql) => /\bDELETE\b/.test(sql))).toBe(false);
    expect(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("UPDATE auth.workload_principals")));
  });
});
