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
  tokenTtlSeconds: 300,
  grantTtlSeconds: 300,
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
      expiresAt: new Date(Date.now() + ttl * 1000),
    })),
    readGrant: vi.fn(async () => ({
      mode: "create" as const,
      principalId,
      jkt,
      expiresAt: new Date(Date.now() + 300_000),
    })),
    consumeGrantAndIssue: vi.fn(async () => undefined),
    rotateToken: vi.fn(async () => undefined),
    isTokenActive: vi.fn(async () => true),
    revoke: vi.fn(async () => 1),
  };
}

function createHarness(store = createStore(), overrides: { verifyToken?: () => Promise<WorkloadTokenClaims | null> } = {}) {
  const audit = vi.fn();
  const issueToken = vi.fn(async () => ({ token: accessToken, claims: { ...claims, cnf: { jkt } } }));
  const verifyToken = vi.fn(overrides.verifyToken ?? (async () => ({ ...claims, cnf: { jkt } })));
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use(createWorkloadParseErrorHandler());
  app.use(createWorkloadRouter({ config, store, issueToken, verifyToken, audit }));
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
    expect(store.createGrant).toHaveBeenCalledWith({ mode: "create", jkt }, 300);
    expect(JSON.stringify(response.body)).not.toMatch(/tenant|agent|worker|enrollment/i);
  });

  it("accepts only an issuer principal and replacement key for rotation grants", async () => {
    const { app, store } = createHarness();
    await request(app)
      .post("/workload/principals/grants")
      .set("Authorization", `Bearer ${config.operatorToken}`)
      .send({ mode: "rotate", principal_id: principalId, cnf_jkt: jkt })
      .expect(201);
    expect(store.createGrant).toHaveBeenCalledWith({ mode: "rotate", principalId, jkt }, 300);

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

  it("renews a live token only with an ath-bound DPoP proof", async () => {
    const { app, store } = createHarness();
    await request(app).post("/workload/token/renew")
      .set("Authorization", `DPoP ${accessToken}`)
      .set("DPoP", await dpopProof(config.renewalEndpointUrl, accessToken)).send({}).expect(200);
    expect(store.rotateToken).toHaveBeenCalledOnce();

    await request(app).post("/workload/token/renew")
      .set("Authorization", `DPoP ${accessToken}`)
      .set("DPoP", await dpopProof(config.renewalEndpointUrl)).send({})
      .expect(401, { error: "invalid_dpop_proof" });
  });

  it("returns only active persisted generic claims from introspection", async () => {
    const { app, store } = createHarness();
    const response = await request(app).post("/workload/token/introspect")
      .set("Authorization", `Bearer ${config.introspectionToken}`).send({ token: accessToken }).expect(200);
    expect(response.body).toMatchObject({ active: true, sub: principalId, token_use: "workload" });
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

    await request(app).post("/workload/revoke").send({ principal_id: principalId })
      .expect(401, { error: "unauthorized" });
  });

  it("rejects renewal without an active DPoP bearer before signing", async () => {
    const { app, issueToken } = createHarness();
    await request(app).post("/workload/token/renew").send({}).expect(401, { error: "invalid_token" });
    await request(app).post("/workload/token/renew").set("Authorization", `DPoP ${accessToken}`)
      .send({ extra: true }).expect(400, { error: "invalid_request" });
    expect(issueToken).not.toHaveBeenCalled();
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
