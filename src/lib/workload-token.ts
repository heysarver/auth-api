import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { EnabledWorkloadConfig } from "./workload-config.js";

export interface WorkloadTokenClaims extends JWTPayload {
  sub: string;
  iss: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  token_use: "workload";
  cnf: { jkt: string };
}

interface BetterAuthJwtSigner {
  signJWT(input: { body: { payload: JWTPayload } }): Promise<{ token: string }>;
}

export interface WorkloadTokenInput {
  principalId: string;
  jkt: string;
}

export interface IssuedWorkloadToken {
  token: string;
  claims: WorkloadTokenClaims;
}

export interface BetterAuthWorkloadTokenAdapter {
  issueToken: (input: WorkloadTokenInput) => Promise<IssuedWorkloadToken>;
  verifyToken: (token: string) => Promise<WorkloadTokenClaims | null>;
}

export function createWorkloadTokenIssuer(
  signer: BetterAuthJwtSigner,
  config: EnabledWorkloadConfig,
  now: () => number = () => Math.floor(Date.now() / 1000),
): (input: WorkloadTokenInput) => Promise<IssuedWorkloadToken> {
  return async (input) => {
    const issuedAt = now();
    const claims: WorkloadTokenClaims = {
      sub: input.principalId,
      iss: config.issuer,
      aud: config.audience,
      jti: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + config.tokenTtlSeconds,
      token_use: "workload",
      cnf: { jkt: input.jkt },
    };
    const response = await signer.signJWT({ body: { payload: claims } });
    return { token: response.token, claims };
  };
}

function normalizedClaims(payload: JWTPayload, config: EnabledWorkloadConfig): WorkloadTokenClaims | null {
  const cnf = payload.cnf;
  const now = Math.floor(Date.now() / 1000);
  const requiredClaims = ["aud", "cnf", "exp", "iat", "iss", "jti", "sub", "token_use"];
  const actualClaims = Object.keys(payload).sort();
  const uuid = (value: unknown): value is string => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (
    actualClaims.length !== requiredClaims.length ||
    !actualClaims.every((claim, index) => claim === requiredClaims[index]) ||
    payload.token_use !== "workload" ||
    !uuid(payload.sub) ||
    payload.iss !== config.issuer ||
    payload.aud !== config.audience ||
    !uuid(payload.jti) ||
    typeof payload.iat !== "number" || !Number.isInteger(payload.iat) ||
    typeof payload.exp !== "number" || !Number.isInteger(payload.exp) ||
    payload.iat > now + config.dpopClockSkewSeconds ||
    payload.exp <= payload.iat || payload.exp - payload.iat > config.tokenTtlSeconds ||
    !cnf || typeof cnf !== "object" || Array.isArray(cnf) ||
    Object.keys(cnf).length !== 1 ||
    typeof (cnf as Record<string, unknown>).jkt !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test((cnf as Record<string, unknown>).jkt as string)
  ) {
    return null;
  }

  return {
    sub: payload.sub,
    iss: payload.iss,
    aud: payload.aud,
    jti: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
    token_use: "workload",
    cnf: { jkt: (cnf as Record<string, string>).jkt },
  };
}

export function createWorkloadTokenVerifier(
  database: Pick<Pool, "query">,
  config: EnabledWorkloadConfig,
): (token: string) => Promise<WorkloadTokenClaims | null> {
  return async (token) => {
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) {
        return null;
      }

      const result = await database.query<{ publicKey: string }>(
        `SELECT "publicKey"
           FROM auth.jwks
          WHERE id = $1
          LIMIT 1`,
        [header.kid],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }

      const jwk = JSON.parse(row.publicKey);
      const key = await importJWK(jwk, "RS256");
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.audience,
      });
      return normalizedClaims(payload, config);
    } catch {
      return null;
    }
  };
}

/**
 * Compatibility boundary for Better Auth 1.6.x, which can sign arbitrary JWT
 * payloads but does not yet provide the complete workload subject, jti, sender
 * binding, or revocation contract. Keep routes dependent on this adapter so a
 * stable native Better Auth implementation can replace it without API changes.
 */
export function createBetterAuthWorkloadTokenAdapter(
  signer: BetterAuthJwtSigner,
  database: Pick<Pool, "query">,
  config: EnabledWorkloadConfig,
): BetterAuthWorkloadTokenAdapter {
  return {
    issueToken: createWorkloadTokenIssuer(signer, config),
    verifyToken: createWorkloadTokenVerifier(database, config),
  };
}
