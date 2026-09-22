import { describe, expect, it, vi } from "vitest";
import {
  createBetterAuthJwtVerifier,
  createPostgresSessionActivityChecker,
  createTokenIntrospectionHandler,
  createTokenIntrospectionParseErrorHandler,
  type IntrospectionClaims,
} from "../../lib/token-introspection.js";

const claims: IntrospectionClaims = {
  sub: "user-id",
  iss: "https://auth.example.test",
  aud: "test-control-plane",
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

describe("token introspection parse error handler", () => {
  it("returns 400 for entity.parse.failed on /token/introspect", () => {
    const handler = createTokenIntrospectionParseErrorHandler();
    const res: any = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();
    handler({ type: "entity.parse.failed" } as any, { path: "/token/introspect" } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "invalid_request" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 413 for entity.too.large on /token/introspect", () => {
    const handler = createTokenIntrospectionParseErrorHandler();
    const res: any = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();
    handler({ type: "entity.too.large" } as any, { path: "/token/introspect" } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes through errors that are not introspection parse errors", () => {
    const handler = createTokenIntrospectionParseErrorHandler();
    const res: any = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const next = vi.fn();
    const otherError = new Error("boom");
    handler(otherError, { path: "/other" } as any, res, next);
    expect(next).toHaveBeenCalledWith(otherError);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("token introspection handler audit default", () => {
  it("uses the default audit logger when no audit dependency is provided", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const handler = createTokenIntrospectionHandler({
      machineToken: "m1",
      clientId: "test-client",
      verifyToken: async () => null,
      isSessionActive: async () => false,
    } as any);
    const res: any = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    handler({ body: {} } as any, res, () => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});
