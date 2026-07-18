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
  audience: "workload-audience",
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
  principalId: "11111111-1111-4111-8111-111111111111",
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
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: input.principalId,
    iss: config.issuer,
    aud: config.audience,
    jti: "22222222-2222-4222-8222-222222222222",
    iat: now,
    exp: now + 300,
    token_use: "workload",
    cnf: { jkt: input.jkt },
    ...payloadOverrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .sign(privateKey);
}

describe("workload token issuance", () => {
  it("builds the exact generic short-lived workload claim profile", async () => {
    const signJWT = vi.fn(async () => ({ token: "signed-token" }));
    const issue = createWorkloadTokenIssuer({ signJWT }, config, () => 1_800_000_000);
    const result = await issue(input);

    expect(result.token).toBe("signed-token");
    expect(result.claims).toEqual({
      sub: input.principalId,
      iss: config.issuer,
      aud: config.audience,
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      token_use: "workload",
      cnf: { jkt: input.jkt },
    });
    expect(signJWT).toHaveBeenCalledWith({ body: { payload: result.claims } });
  });
});

describe("workload token verification", () => {
  const database = {
    query: vi.fn(async () => ({ rows: [{ publicKey: JSON.stringify(publicJwk) }], rowCount: 1 })),
  };

  it("verifies RS256, kid, issuer, exact audience, token use, principal, and sender binding", async () => {
    database.query.mockResolvedValue({ rows: [{ publicKey: JSON.stringify(publicJwk) }], rowCount: 1 });
    const verify = createWorkloadTokenVerifier(database as never, config);
    await expect(verify(await signedToken())).resolves.toEqual(expect.objectContaining({
      sub: input.principalId,
      aud: config.audience,
      cnf: { jkt: input.jkt },
    }));
  });

  it.each([
    ["human token", { token_use: "human" }],
    ["wrong audience", { aud: "human-control-plane" }],
    ["multi-audience token", { aud: [config.audience, "human-control-plane"] }],
    ["missing sender binding", { cnf: undefined }],
    ["non-UUID principal", { sub: "consumer-worker-1" }],
    ["consumer authorization claim", { tenant_id: "tenant-1" }],
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
      sub: input.principalId,
      token_use: "workload",
    });
  });
});
