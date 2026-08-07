import { createHash } from "node:crypto";
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { WorkloadError } from "./workload-errors.js";

const MAX_PROOF_LENGTH = 16_384;
const MAX_PROOF_JTI_LENGTH = 200;

export interface VerifiedDpopProof {
  jkt: string;
  proofJti: string;
  expiresAt: Date;
}

export interface VerifyDpopProofInput {
  proof: string | undefined;
  method: string;
  url: string;
  expectedJkt?: string;
  accessToken?: string;
  now?: number;
  clockSkewSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicEs256Jwk(value: unknown): JWK {
  if (!isRecord(value)) {
    throw new WorkloadError("invalid_dpop_proof", 401);
  }

  if (
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.x !== "string" ||
    value.x.length === 0 ||
    typeof value.y !== "string" ||
    value.y.length === 0 ||
    "d" in value ||
    (value.alg !== undefined && value.alg !== "ES256") ||
    (value.use !== undefined && value.use !== "sig") ||
    (value.key_ops !== undefined && (
      !Array.isArray(value.key_ops) ||
      value.key_ops.some((operation) => operation !== "verify")
    ))
  ) {
    throw new WorkloadError("invalid_dpop_proof", 401);
  }

  return value as JWK;
}

export function accessTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function verifyDpopProof(input: VerifyDpopProofInput): Promise<VerifiedDpopProof> {
  if (!input.proof || input.proof.length === 0 || input.proof.length > MAX_PROOF_LENGTH) {
    throw new WorkloadError("invalid_dpop_proof", 401);
  }

  let header;
  try {
    header = decodeProtectedHeader(input.proof);
  } catch {
    throw new WorkloadError("invalid_dpop_proof", 401);
  }

  if (header.typ?.toLowerCase() !== "dpop+jwt" || header.alg !== "ES256") {
    throw new WorkloadError("invalid_dpop_proof", 401);
  }

  const jwk = publicEs256Jwk(header.jwk);
  const jkt = await calculateJwkThumbprint(jwk, "sha256");
  if (input.expectedJkt && jkt !== input.expectedJkt) {
    throw new WorkloadError("invalid_dpop_proof", 401);
  }

  try {
    const key = await importJWK(jwk, "ES256");
    const { payload } = await jwtVerify(input.proof, key, {
      algorithms: ["ES256"],
      typ: "dpop+jwt",
    });
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const requiredClaims = input.accessToken
      ? ["ath", "htm", "htu", "iat", "jti"]
      : ["htm", "htu", "iat", "jti"];
    const actualClaims = Object.keys(payload).sort();
    if (
      actualClaims.length !== requiredClaims.length ||
      !actualClaims.every((claim, index) => claim === [...requiredClaims].sort()[index])
    ) {
      throw new WorkloadError("invalid_dpop_proof", 401);
    }

    if (
      typeof payload.jti !== "string" ||
      payload.jti.length === 0 ||
      payload.jti.length > MAX_PROOF_JTI_LENGTH ||
      typeof payload.iat !== "number" ||
      !Number.isInteger(payload.iat) ||
      Math.abs(now - payload.iat) > input.clockSkewSeconds ||
      payload.htm !== input.method.toUpperCase() ||
      payload.htu !== input.url
    ) {
      throw new WorkloadError("invalid_dpop_proof", 401);
    }

    if (input.accessToken) {
      if (payload.ath !== accessTokenHash(input.accessToken)) {
        throw new WorkloadError("invalid_dpop_proof", 401);
      }
    } else if (payload.ath !== undefined) {
      throw new WorkloadError("invalid_dpop_proof", 401);
    }

    return {
      jkt,
      proofJti: payload.jti,
      expiresAt: new Date((payload.iat + input.clockSkewSeconds + 1) * 1000),
    };
  } catch (error) {
    if (error instanceof WorkloadError) {
      throw error;
    }
    throw new WorkloadError("invalid_dpop_proof", 401);
  }
}
