import express from "express";
import rateLimit from "express-rate-limit";
import { generateKeyPairSync } from "node:crypto";
import { sign, verify } from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTokenIntrospectionParseErrorHandler,
  createTokenIntrospectionHandler,
  tokenIntrospectionRateLimitHandler,
  type IntrospectionClaims,
} from "../../lib/token-introspection.js";

const MACHINE_TOKEN = "test-machine-credential-not-a-real-secret";
const ORIGINAL_JWT = "header.payload.signature";
const NOW = 1_735_689_000;
const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const forgedKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

const activeClaims: IntrospectionClaims & Record<string, unknown> = {
  sub: "human-subject-id",
  iss: "https://auth.example.test",
  aud: "nebulaios-control-plane",
  exp: NOW + 300,
  jti: "session-revision-id",
  email: "must-not-be-returned@example.test",
  role: "must-not-be-returned",
  tenant: "must-not-be-returned",
};

interface HarnessOptions {
  verifyToken?: (token: string) => Promise<unknown | null>;
  isSessionActive?: (claims: IntrospectionClaims) => Promise<boolean>;
  machineToken?: string | undefined;
  audit?: (event: {
    event: "token_introspection";
    clientId: string;
    outcome: "active" | "inactive" | "invalid_request" | "misconfigured" | "unauthorized";
  }) => void;
}

function createHarness(options: HarnessOptions = {}) {
  const verifyToken = options.verifyToken ?? vi.fn(async () => activeClaims);
  const isSessionActive = options.isSessionActive ?? vi.fn(async () => true);
  const audit = options.audit ?? vi.fn();
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use(createTokenIntrospectionParseErrorHandler());
  app.post(
    "/token/introspect",
    rateLimit({ windowMs: 60_000, limit: 1_000, legacyHeaders: false }),
    createTokenIntrospectionHandler({
      machineToken: "machineToken" in options ? options.machineToken : MACHINE_TOKEN,
      clientId: "nebulaios",
      verifyToken,
      isSessionActive,
      now: () => NOW,
      audit,
    }),
  );
  app.use(createTokenIntrospectionParseErrorHandler());
  return { app, verifyToken, isSessionActive, audit };
}

function introspect(app: express.Express, token = ORIGINAL_JWT, machineToken = MACHINE_TOKEN) {
  return request(app)
    .post("/token/introspect")
    .set("Authorization", `Bearer ${machineToken}`)
    .send({ token });
}

describe("POST /token/introspect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the exact active contract with claims matching the verified JWT", async () => {
    const { app } = createHarness();

    const response = await introspect(app);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, max-age=30");
    expect(response.body).toEqual({
      active: true,
      sub: activeClaims.sub,
      iss: activeClaims.iss,
      aud: activeClaims.aud,
      exp: activeClaims.exp,
      jti: activeClaims.jti,
    });
    expect(Object.keys(response.body)).toEqual(["active", "sub", "iss", "aud", "exp", "jti"]);
  });

  it.each(["sign-out", "session revocation", "credential reset", "user disablement"])(
    "returns inactive after %s removes or disables the durable session",
    async () => {
      let active = true;
      const { app } = createHarness({ isSessionActive: vi.fn(async () => active) });
      expect((await introspect(app)).body).toMatchObject({ active: true });

      active = false;
      const response = await introspect(app);

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toEqual({ active: false });
    },
  );

  it("never reports expired, malformed, forged, wrong-issuer, or wrong-audience JWTs as active", async () => {
    const verifyToken = vi.fn(async (token: string) => {
      try {
        const payload = verify(token, signingKeys.publicKey, {
          algorithms: ["RS256"],
          issuer: activeClaims.iss,
          audience: activeClaims.aud,
          clockTimestamp: NOW,
        });
        return typeof payload === "string" ? null : payload;
      } catch {
        return null;
      }
    });
    const { app, isSessionActive } = createHarness({ verifyToken });
    const basePayload = { sub: activeClaims.sub, jti: activeClaims.jti };
    const invalidTokens = [
      sign({ ...basePayload, exp: NOW - 1 }, signingKeys.privateKey, {
        algorithm: "RS256", keyid: "test-key", issuer: activeClaims.iss, audience: activeClaims.aud,
      }),
      "malformed",
      sign({ ...basePayload, exp: NOW + 300 }, forgedKeys.privateKey, {
        algorithm: "RS256", keyid: "forged-key", issuer: activeClaims.iss, audience: activeClaims.aud,
      }),
      sign({ ...basePayload, exp: NOW + 300 }, signingKeys.privateKey, {
        algorithm: "RS256", keyid: "test-key", issuer: "https://wrong-issuer.example", audience: activeClaims.aud,
      }),
      sign({ ...basePayload, exp: NOW + 300 }, signingKeys.privateKey, {
        algorithm: "RS256", keyid: "test-key", issuer: activeClaims.iss, audience: "wrong-audience",
      }),
    ];

    for (const token of invalidTokens) {
      const response = await introspect(app, token);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ active: false });
    }
    expect(isSessionActive).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized machine client before evaluating token status", async () => {
    const { app, verifyToken, isSessionActive } = createHarness();

    const response = await introspect(app, ORIGINAL_JWT, "wrong-machine-credential");

    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ error: "unauthorized" });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(isSessionActive).not.toHaveBeenCalled();
  });

  it("fails closed when the machine credential is not configured", async () => {
    const { app, verifyToken } = createHarness({ machineToken: undefined });

    const response = await introspect(app);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "service_unavailable" });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("fails closed when the configured machine credential is too short", async () => {
    const { app, verifyToken } = createHarness({ machineToken: "too-short" });

    const response = await introspect(app);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "service_unavailable" });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { token: "" },
    { token: ORIGINAL_JWT, extra: true },
    { token: 123 },
  ])("rejects a non-contract request body without token disclosure", async (body) => {
    const { app, verifyToken } = createHarness();

    const response = await request(app)
      .post("/token/introspect")
      .set("Authorization", `Bearer ${MACHINE_TOKEN}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_request" });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("does not expose profile, role, tenant, cookie, secret, or revocation details", async () => {
    const { app } = createHarness();

    const response = await introspect(app);
    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("role");
    expect(serialized).not.toContain("tenant");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("reason");
  });

  it("keeps the raw JWT and machine credential out of audit output on failures", async () => {
    const audit = vi.fn();
    const { app } = createHarness({
      verifyToken: vi.fn(async () => {
        throw new Error(`verification failed for sensitive input`);
      }),
      audit,
    });

    const response = await introspect(app);
    const auditOutput = JSON.stringify(audit.mock.calls);

    expect(response.body).toEqual({ active: false });
    expect(auditOutput).not.toContain(ORIGINAL_JWT);
    expect(auditOutput).not.toContain(MACHINE_TOKEN);
    expect(auditOutput).toContain("inactive");
  });

  it("handles malformed JSON inside the redaction boundary", async () => {
    const { app, verifyToken, audit } = createHarness();
    const sensitiveMalformedBody = `{"token":"${ORIGINAL_JWT}"`;

    const response = await request(app)
      .post("/token/introspect")
      .set("Authorization", `Bearer ${MACHINE_TOKEN}`)
      .set("Content-Type", "application/json")
      .send(sensitiveMalformedBody);

    const consoleOutput = JSON.stringify([
      vi.mocked(console.log).mock.calls,
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]);
    expect(response.status).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ error: "invalid_request" });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(consoleOutput).not.toContain(ORIGINAL_JWT);
    expect(consoleOutput).not.toContain(MACHINE_TOKEN);
  });

  it("keeps malformed JSON redacted on the accepted trailing-slash route", async () => {
    const { app, verifyToken } = createHarness();

    const response = await request(app)
      .post("/token/introspect/")
      .set("Authorization", `Bearer ${MACHINE_TOKEN}`)
      .set("Content-Type", "application/json")
      .send(`{"token":"${ORIGINAL_JWT}"`);

    expect(response.status).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ error: "invalid_request" });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(ORIGINAL_JWT);
  });

  it("rejects oversized bodies without exposing token content", async () => {
    const { app, verifyToken } = createHarness();
    const oversizedToken = `header.${"x".repeat(17_000)}.signature`;

    const response = await introspect(app, oversizedToken);

    expect(response.status).toBe(413);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ error: "invalid_request" });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(oversizedToken);
  });

  it("makes rate-limit denials non-cacheable", async () => {
    const app = express();
    app.post("/limited", tokenIntrospectionRateLimitHandler);

    const response = await request(app).post("/limited");

    expect(response.status).toBe(429);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ error: "rate_limited" });
  });
});
