import { beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import type { EnabledWorkloadConfig } from "../../lib/workload-config.js";
import {
  createBetterAuthWorkloadTokenAdapter,
  createWorkloadTokenIssuer,
  createWorkloadTokenVerifier,
} from "../../lib/workload-token.js";

const config: EnabledWorkloadConfig = {
  enabled: true,
  issuer: "https://auth.example.test",
  audience: "worker-audience",
  tokenEndpointUrl: "https://auth.example.test/workload/token",
  renewalEndpointUrl: "https://auth.example.test/workload/token/renew",
  operatorToken: "operator-credential-that-is-long-enough",
  introspectionToken: "introspection-credential-long-enough",
  tokenTtlSeconds: 300,
  grantTtlSeconds: 300,
  dpopClockSkewSeconds: 60,
  rateLimitMax: 120,
};

const input = {
  workerId: "worker-1",
  tenantId: "tenant-1",
  agentId: "agent-1",
  enrollmentId: "enrollment-1",
  jkt: "A".repeat(43),
};

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let publicJwk: JWK;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey);
});

async function signedToken(payloadOverrides: Record<string, unknown> = {}): Promise<string> {
  const payload = {
    sub: input.workerId,
    iss: config.issuer,
    aud: config.audience,
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    enrollment_id: input.enrollmentId,
    jti: "11111111-1111-4111-8111-111111111111",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    token_use: "workload",
    cnf: { jkt: input.jkt },
    ...payloadOverrides,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .sign(privateKey);
}

describe("workload token issuance", () => {
  it("builds the exact short-lived workload claim profile", async () => {
    const signJWT = vi.fn(async () => ({ token: "signed-token" }));
    const issue = createWorkloadTokenIssuer({ signJWT }, config, () => 1_800_000_000);
    const result = await issue(input);

    expect(result.token).toBe("signed-token");
    expect(result.claims).toMatchObject({
      sub: "worker-1",
      iss: config.issuer,
      aud: config.audience,
      tenant_id: "tenant-1",
      agent_id: "agent-1",
      enrollment_id: "enrollment-1",
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      token_use: "workload",
      cnf: { jkt: input.jkt },
    });
    expect(result.claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(signJWT).toHaveBeenCalledWith({ body: { payload: result.claims } });
  });
});

describe("workload token verification", () => {
  const database = {
    query: vi.fn(async () => ({ rows: [{ publicKey: JSON.stringify(publicJwk) }], rowCount: 1 })),
  };

  it("verifies RS256, kid, issuer, exact audience, token use, and worker claims", async () => {
    database.query.mockResolvedValue({ rows: [{ publicKey: JSON.stringify(publicJwk) }], rowCount: 1 });
    const verify = createWorkloadTokenVerifier(database as never, config);
    await expect(verify(await signedToken())).resolves.toMatchObject({
      sub: input.workerId,
      aud: config.audience,
      enrollment_id: input.enrollmentId,
      cnf: { jkt: input.jkt },
    });
  });

  it.each([
    ["human token", { token_use: "human" }],
    ["wrong audience", { aud: "human-control-plane" }],
    ["multi-audience token", { aud: [config.audience, "human-control-plane"] }],
    ["missing sender binding", { cnf: undefined }],
    ["missing enrollment", { enrollment_id: undefined }],
    ["extra unapproved claim", { scope: "admin" }],
    ["overlong lifetime", { exp: Math.floor(Date.now() / 1000) + 301 }],
  ])("rejects a %s", async (_label, overrides) => {
    database.query.mockResolvedValue({ rows: [{ publicKey: JSON.stringify(publicJwk) }], rowCount: 1 });
    const verify = createWorkloadTokenVerifier(database as never, config);
    await expect(verify(await signedToken(overrides))).resolves.toBeNull();
  });

  it("rejects unknown signing keys without attempting fallback verification", async () => {
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const verify = createWorkloadTokenVerifier(database as never, config);
    await expect(verify(await signedToken())).resolves.toBeNull();
  });
});

describe("Better Auth workload compatibility adapter", () => {
  it("provides the temporary stable-version issuance and verification boundary", async () => {
    const signJWT = vi.fn(async () => ({ token: "signed-token" }));
    const database = {
      query: vi.fn(async () => ({ rows: [{ publicKey: JSON.stringify(publicJwk) }], rowCount: 1 })),
    };
    const adapter = createBetterAuthWorkloadTokenAdapter({ signJWT }, database as never, config);

    await expect(adapter.issueToken(input)).resolves.toMatchObject({ token: "signed-token" });
    await expect(adapter.verifyToken(await signedToken())).resolves.toMatchObject({
      sub: input.workerId,
      token_use: "workload",
    });
  });
});
