import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";
import type { EnabledWorkloadConfig } from "../../lib/workload-config.js";
import { accessTokenHash } from "../../lib/workload-dpop.js";
import { WorkloadError } from "../../lib/workload-errors.js";
import { createWorkloadParseErrorHandler, createWorkloadRouter } from "../../lib/workload-routes.js";
import type { WorkloadStore } from "../../lib/workload-store.js";
import type { WorkloadTokenClaims } from "../../lib/workload-token.js";

const config: EnabledWorkloadConfig = {
  enabled: true,
  issuer: "https://auth.example.test",
  audience: "workload-audience",
  tokenEndpointUrl: "https://auth.example.test/workload/token",
  renewalEndpointUrl: "https://auth.example.test/workload/token/renew",
  operatorToken: "operator-credential-that-is-long-enough",
  introspectionToken: "introspection-credential-long-enough",
  renewalKey: "renewal-key",
  tokenTtlSeconds: 300,
  grantTtlSeconds: 300,
  renewalTtlSeconds: 31_536_000,
  renewalIdempotencyTtlSeconds: 120,
  dpopClockSkewSeconds: 60,
  rateLimitMax: 120,
};

const principalId = "11111111-1111-4111-8111-111111111111";
const grantSecret = "one-time-principal-grant";
const accessToken = "header.payload.signature";
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let publicJwk: JWK;
let jkt: string;

const claims: WorkloadTokenClaims = {
  sub: principalId,
  iss: config.issuer,
  aud: config.audience,
  jti: "22222222-2222-4222-8222-222222222222",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300,
  token_use: "workload",
  cnf: { jkt: "pending" },
};

async function dpopProof(url: string, token?: string): Promise<string> {
  return new SignJWT({
    htm: "POST",
    htu: url,
    iat: Math.floor(Date.now() / 1000),
    jti: randomUUID(),
    ...(token ? { ath: accessTokenHash(token) } : {}),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
    .sign(privateKey);
}

function createStore(): WorkloadStore {
  return {
    createGrant: vi.fn(async (input, ttl) => ({
      mode: input.mode,
      principalId: input.mode === "create" ? principalId : input.principalId,
      jkt: input.jkt,
      grant: grantSecret,
      renewable: input.renewable === true,
      expiresAt: new Date(Date.now() + ttl * 1000),
    })),
    readGrant: vi.fn(async () => ({
      mode: "create" as const,
      principalId,
      jkt,
      renewable: false,
      expiresAt: new Date(Date.now() + 300_000),
    })),
    consumeGrantAndIssue: vi.fn(async () => null),
    rotateToken: vi.fn(async () => undefined),
    readRenewalCredential: vi.fn(async () => ({ jkt, principalId })),
    rotateRenewalCredential: vi.fn(async (_credential, _key, _proof, next) => ({
      credential: `wrc1_${"A".repeat(43)}`,
      familyId: "33333333-3333-4333-8333-333333333333",
      generation: 1,
      expiresAt: new Date(Date.now() + config.renewalTtlSeconds * 1000),
      claims: next,
    })),
    isTokenActive: vi.fn(async () => true),
    credentialFamilyForToken: vi.fn(async () => null),
    revoke: vi.fn(async () => 1),
  };
}

function createHarness(store = createStore(), overrides: { verifyToken?: () => Promise<WorkloadTokenClaims | null> } = {}) {
  const audit = vi.fn();
  const issueToken = vi.fn(async () => ({ token: accessToken, claims: { ...claims, cnf: { jkt } } }));
  const verifyToken = vi.fn(overrides.verifyToken ?? (async () => ({ ...claims, cnf: { jkt } })));
  const signTokenClaims = vi.fn(async (signedClaims: WorkloadTokenClaims) => ({ token: accessToken, claims: signedClaims }));
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use(createWorkloadParseErrorHandler());
  app.use(createWorkloadRouter({ config, store, issueToken, signTokenClaims, verifyToken, audit }));
  app.use(createWorkloadParseErrorHandler());
  return { app, store, issueToken, audit };
}

beforeAll(async () => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey);
  jkt = await calculateJwkThumbprint(publicJwk);
});

beforeEach(() => vi.restoreAllMocks());

describe("generic workload principal routes", () => {
  it("creates an issuer-owned principal and one-time grant from only a key thumbprint", async () => {
    const { app, store } = createHarness();
    const body = { mode: "create", cnf_jkt: jkt };

    await request(app).post("/workload/principals/grants").send(body).expect(401, { error: "unauthorized" });
    const response = await request(app)
      .post("/workload/principals/grants")
      .set("Authorization", `Bearer ${config.operatorToken}`)
      .send(body)
      .expect(201);

    expect(response.body).toMatchObject({ principal_id: principalId, grant: grantSecret });
    expect(store.createGrant).toHaveBeenCalledWith({ mode: "create", jkt, renewable: false }, 300);
    expect(JSON.stringify(response.body)).not.toMatch(/tenant|agent|worker|enrollment/i);
  });

  it("honors an operator-selected grant lifetime up to 24 hours", async () => {
    const { app, store } = createHarness();
    await request(app)
      .post("/workload/principals/grants")
      .set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ mode: "create", cnf_jkt: jkt, expires_in: 86_400 })
      .expect(201);

    expect(store.createGrant).toHaveBeenCalledWith({ mode: "create", jkt, renewable: false }, 86_400);

    await request(app)
      .post("/workload/principals/grants")
      .set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ mode: "create", cnf_jkt: jkt, expires_in: 86_401 })
      .expect(400, { error: "invalid_request" });
  });

  it("makes renewable grants explicit without changing the default response", async () => {
    const { app, store } = createHarness();
    const renewable = await request(app)
      .post("/workload/principals/grants")
      .set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ mode: "create", cnf_jkt: jkt, renewable: true })
      .expect(201);
    expect(renewable.body.renewable).toBe(true);
    expect(store.createGrant).toHaveBeenCalledWith({ mode: "create", jkt, renewable: true }, 300);

    const legacy = await request(createHarness().app)
      .post("/workload/principals/grants")
      .set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ mode: "create", cnf_jkt: jkt })
      .expect(201);
    expect(legacy.body).not.toHaveProperty("renewable");
  });

  it("accepts only an issuer principal and replacement key for rotation grants", async () => {
    const { app, store } = createHarness();
    await request(app)
      .post("/workload/principals/grants")
      .set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ mode: "rotate", principal_id: principalId, cnf_jkt: jkt })
      .expect(201);
    expect(store.createGrant).toHaveBeenCalledWith({ mode: "rotate", principalId, jkt, renewable: false }, 300);

    await request(app)
      .post("/workload/principals/grants")
      .set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ mode: "create", principal_id: principalId, cnf_jkt: jkt })
      .expect(400, { error: "invalid_request" });
  });

  it("exchanges a grant only with the bound DPoP key and exact endpoint", async () => {
    const { app, store, audit } = createHarness();
    const response = await request(app)
      .post("/workload/token")
      .set("DPoP", await dpopProof(config.tokenEndpointUrl))
      .send({ grant: grantSecret })
      .expect(200);

    expect(response.body).toEqual({ access_token: accessToken, token_type: "DPoP", expires_in: 300 });
    expect(store.consumeGrantAndIssue).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.mock.calls)).not.toContain(grantSecret);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(accessToken);
  });

  it("rejects the wrong DPoP key before consuming a grant", async () => {
    const otherKeys = await generateKeyPair("ES256", { extractable: true });
    const otherJwk = await exportJWK(otherKeys.publicKey);
    const wrongProof = await new SignJWT({
      htm: "POST", htu: config.tokenEndpointUrl, iat: Math.floor(Date.now() / 1000), jti: randomUUID(),
    }).setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: otherJwk }).sign(otherKeys.privateKey);
    const { app, store } = createHarness();

    await request(app).post("/workload/token").set("DPoP", wrongProof).send({ grant: grantSecret })
      .expect(401, { error: "invalid_dpop_proof" });
    expect(store.consumeGrantAndIssue).not.toHaveBeenCalled();
  });

  it("renews with a rotating credential, stable idempotency key, and enrolled DPoP key", async () => {
    const { app, store } = createHarness();
    const renewalCredential = `wrc1_${"A".repeat(43)}`;
    await request(app).post("/workload/token/renew")
      .set("Idempotency-Key", "renewal-request-1")
      .set("DPoP", await dpopProof(config.renewalEndpointUrl))
      .send({ renewal_credential: renewalCredential }).expect(200);
    expect(store.rotateRenewalCredential).toHaveBeenCalledWith(
      renewalCredential,
      "renewal-request-1",
      expect.objectContaining({ jkt }),
      expect.objectContaining({ sub: principalId, cnf: { jkt } }),
    );

    await request(app).post("/workload/token/renew")
      .set("Idempotency-Key", "renewal-request-2")
      .set("DPoP", await dpopProof(config.renewalEndpointUrl, accessToken))
      .send({ renewal_credential: renewalCredential })
      .expect(401, { error: "invalid_dpop_proof" });
  });

  it("returns only active persisted generic claims from introspection", async () => {
    const { app, store } = createHarness();
    vi.mocked(store.credentialFamilyForToken).mockResolvedValue(
      "33333333-3333-4333-8333-333333333333",
    );
    const response = await request(app).post("/workload/token/introspect")
      .set("Authorization", `Bearer ${config.introspectionToken}`).send({ token: accessToken }).expect(200);
    expect(response.body).toMatchObject({
      active: true,
      sub: principalId,
      token_use: "workload",
      credential_family_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(response.body).not.toHaveProperty("tenant_id");
    expect(response.headers["cache-control"]).toBe("no-store");

    vi.mocked(store.isTokenActive).mockResolvedValue(false);
    await request(app).post("/workload/token/introspect")
      .set("Authorization", `Bearer ${config.introspectionToken}`).send({ token: accessToken })
      .expect(200, { active: false });
  });

  it("requires the dedicated machine credential for workload introspection", async () => {
    const { app } = createHarness();
    await request(app).post("/workload/token/introspect")
      .set("Authorization", `Bearer ${accessToken}`).send({ token: accessToken })
      .expect(401, { error: "unauthorized" });
  });

  it("revokes by exactly one operator-authorized generic selector", async () => {
    const { app, store } = createHarness();
    await request(app).post("/workload/revoke").set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ principal_id: principalId }).expect(204);
    expect(store.revoke).toHaveBeenCalledWith({ principalId });

    await request(app).post("/workload/revoke").set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ principal_id: principalId, jti: claims.jti }).expect(400, { error: "invalid_request" });

    await request(app).post("/workload/revoke").set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ jti: claims.jti }).expect(204);
    expect(store.revoke).toHaveBeenCalledWith({ jti: claims.jti });

    const familyId = "33333333-3333-4333-8333-333333333333";
    await request(app).post("/workload/revoke").set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ credential_family_id: familyId }).expect(204);
    expect(store.revoke).toHaveBeenCalledWith({ familyId });

    await request(app).post("/workload/revoke").send({ principal_id: principalId })
      .expect(401, { error: "unauthorized" });
  });

  it("preserves legacy access-token renewal and rejects incomplete credential renewal", async () => {
    const { app, issueToken } = createHarness();
    await request(app).post("/workload/token/renew")
      .set("Authorization", `DPoP ${accessToken}`)
      .set("DPoP", await dpopProof(config.renewalEndpointUrl, accessToken))
      .send({})
      .expect(200);
    expect(issueToken).toHaveBeenCalledOnce();

    await request(app).post("/workload/token/renew")
      .send({ renewal_credential: `wrc1_${"A".repeat(43)}` })
      .expect(400, { error: "invalid_request" });
  });

  it("keeps legacy exchange unchanged and adds renewable fields only for opt-in grants", async () => {
    const store = createStore();
    vi.mocked(store.consumeGrantAndIssue).mockResolvedValue({
      credential: `wrc1_${"A".repeat(43)}`,
      familyId: "33333333-3333-4333-8333-333333333333",
      generation: 0,
      expiresAt: new Date(Date.now() + config.renewalTtlSeconds * 1000),
    });
    const { app } = createHarness(store);
    const response = await request(app).post("/workload/token")
      .set("DPoP", await dpopProof(config.tokenEndpointUrl))
      .send({ grant: grantSecret }).expect(200);
    expect(response.body).toMatchObject({
      renewal_credential: `wrc1_${"A".repeat(43)}`,
      credential_family_id: "33333333-3333-4333-8333-333333333333",
      renewal_generation: 0,
    });

    const legacy = createStore();
    const legacyResponse = await request(createHarness(legacy).app).post("/workload/token")
      .set("DPoP", await dpopProof(config.tokenEndpointUrl))
      .send({ grant: grantSecret }).expect(200);
    expect(legacyResponse.body).toEqual({ access_token: accessToken, token_type: "DPoP", expires_in: 300 });
  });

  it("fails closed and keeps credential-bearing errors secret-safe", async () => {
    const store = createStore();
    vi.mocked(store.consumeGrantAndIssue).mockRejectedValue(new Error("database unavailable"));
    const { app } = createHarness(store);
    await request(app).post("/workload/token").set("DPoP", await dpopProof(config.tokenEndpointUrl))
      .send({ grant: grantSecret }).expect(503, { error: "service_unavailable" });

    const malformed = await request(app).post("/workload/token").set("Content-Type", "application/json")
      .send(`{"grant":"${grantSecret}"`).expect(400);
    expect(malformed.body).toEqual({ error: "invalid_request" });
    expect(JSON.stringify(malformed.body)).not.toContain(grantSecret);

    await request(app).post("/workload/token").set("Content-Type", "application/json")
      .send(JSON.stringify({ grant: "x".repeat(17_000) }))
      .expect(413, { error: "invalid_request" });
  });

  it("maps one-time consumption failures to a secret-safe grant error", async () => {
    const store = createStore();
    vi.mocked(store.consumeGrantAndIssue).mockRejectedValue(new WorkloadError("invalid_grant", 400));
    const { app } = createHarness(store);
    await request(app).post("/workload/token").set("DPoP", await dpopProof(config.tokenEndpointUrl))
      .send({ grant: grantSecret }).expect(400, { error: "invalid_grant" });
  });
});
