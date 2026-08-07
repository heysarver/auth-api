import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";
import { accessTokenHash, verifyDpopProof } from "../../lib/workload-dpop.js";

const endpoint = "https://auth.example.test/workload/token";
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let publicJwk: JWK;
let jkt: string;

async function proof(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const now = 1_800_000_000;
  return new SignJWT({
    htm: "POST",
    htu: endpoint,
    iat: now,
    jti: randomUUID(),
    ...overrides,
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk, ...headerOverrides })
    .sign(privateKey);
}

beforeAll(async () => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey);
  jkt = await calculateJwkThumbprint(publicJwk);
});

describe("DPoP proof verification", () => {
  it("verifies method, URL, time, proof id, and RFC 7638 key binding", async () => {
    await expect(verifyDpopProof({
      proof: await proof(),
      method: "POST",
      url: endpoint,
      expectedJkt: jkt,
      now: 1_800_000_000,
      clockSkewSeconds: 60,
    })).resolves.toMatchObject({ jkt });
  });

  it.each([
    ["wrong method", { htm: "GET" }, {}],
    ["wrong URL", { htu: "https://attacker.example/workload/token" }, {}],
    ["stale proof", { iat: 1_799_999_900 }, {}],
    ["missing proof id", { jti: undefined }, {}],
    ["wrong type", {}, { typ: "JWT" }],
    ["unapproved extra claim", { nonce: "not-supported" }, {}],
  ])("rejects %s", async (_label, payloadOverrides, headerOverrides) => {
    await expect(verifyDpopProof({
      proof: await proof(payloadOverrides, headerOverrides),
      method: "POST",
      url: endpoint,
      expectedJkt: jkt,
      now: 1_800_000_000,
      clockSkewSeconds: 60,
    })).rejects.toThrow("invalid_dpop_proof");
  });

  it("rejects a private key embedded in the proof header", async () => {
    const privateJwk = await exportJWK(privateKey);
    await expect(verifyDpopProof({
      proof: await proof({}, { jwk: privateJwk }),
      method: "POST",
      url: endpoint,
      now: 1_800_000_000,
      clockSkewSeconds: 60,
    })).rejects.toThrow("invalid_dpop_proof");
  });

  it("requires ath for renewal and rejects ath during initial exchange", async () => {
    const token = "signed.access.token";
    const boundProof = await proof({ ath: accessTokenHash(token) });
    await expect(verifyDpopProof({
      proof: boundProof,
      method: "POST",
      url: endpoint,
      expectedJkt: jkt,
      accessToken: token,
      now: 1_800_000_000,
      clockSkewSeconds: 60,
    })).resolves.toMatchObject({ jkt });

    await expect(verifyDpopProof({
      proof: boundProof,
      method: "POST",
      url: endpoint,
      expectedJkt: jkt,
      now: 1_800_000_000,
      clockSkewSeconds: 60,
    })).rejects.toThrow("invalid_dpop_proof");

    await expect(verifyDpopProof({
      proof: await proof({ ath: accessTokenHash("different-token") }),
      method: "POST",
      url: endpoint,
      expectedJkt: jkt,
      accessToken: token,
      now: 1_800_000_000,
      clockSkewSeconds: 60,
    })).rejects.toThrow("invalid_dpop_proof");
  });

  it("normalizes malformed and invalid-signature proofs to one safe error", async () => {
    await expect(verifyDpopProof({
      proof: "not-a-jwt",
      method: "POST",
      url: endpoint,
      now: 1_800_000_000,
      clockSkewSeconds: 60,
    })).rejects.toThrow("invalid_dpop_proof");

    const valid = await proof();
    const [protectedHeader, payload, signature] = valid.split(".");
    const tamperedSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const tampered = `${protectedHeader}.${payload}.${tamperedSignature}`;
    await expect(verifyDpopProof({
      proof: tampered,
      method: "POST",
      url: endpoint,
      now: 1_800_000_000,
      clockSkewSeconds: 60,
    })).rejects.toThrow("invalid_dpop_proof");
  });
});
