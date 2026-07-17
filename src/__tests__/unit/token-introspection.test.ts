import { describe, expect, it, vi } from "vitest";
import {
  createBetterAuthJwtVerifier,
  createPostgresSessionActivityChecker,
  type IntrospectionClaims,
} from "../../lib/token-introspection.js";

const claims: IntrospectionClaims = {
  sub: "user-id",
  iss: "https://auth.example.test",
  aud: "nebulaios-control-plane",
  exp: 1_735_689_600,
  jti: "session-id",
};

describe("PostgreSQL session activity checker", () => {
  it("uses the durable session revision and subject without querying by raw JWT", async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rowCount: 1 }));
    const isActive = createPostgresSessionActivityChecker({ query } as never);

    await expect(isActive(claims)).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toEqual(["session-id", "user-id"]);
    expect(query.mock.calls[0][0]).toContain("users.disabled = FALSE");
    expect(query.mock.calls[0][0]).toContain('session."expiresAt" > CURRENT_TIMESTAMP');
  });

  it("returns false when the durable session is missing, expired, revoked, or disabled", async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rowCount: 0 }));
    const isActive = createPostgresSessionActivityChecker({ query } as never);

    await expect(isActive(claims)).resolves.toBe(false);
  });
});

describe("Better Auth JWT verifier adapter", () => {
  it("passes the original bearer JWT only to Better Auth's server verifier", async () => {
    const payload = { ...claims };
    const verifyJWT = vi.fn(async () => ({ payload }));
    const verify = createBetterAuthJwtVerifier({ verifyJWT });

    await expect(verify("original.jwt.value")).resolves.toEqual(payload);
    expect(verifyJWT).toHaveBeenCalledWith({ body: { token: "original.jwt.value" } });
  });
});
