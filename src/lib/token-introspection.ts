import { createHash, timingSafeEqual } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Pool } from "pg";

const MAX_TOKEN_LENGTH = 16_384;
const MIN_MACHINE_TOKEN_LENGTH = 32;

export interface IntrospectionClaims {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  jti: string;
}

interface IntrospectionAuditEvent {
  event: "token_introspection";
  clientId: string;
  outcome: "active" | "inactive" | "invalid_request" | "misconfigured" | "unauthorized";
}

export interface TokenIntrospectionDependencies {
  machineToken: string | undefined;
  clientId: string;
  verifyToken: (token: string) => Promise<unknown | null>;
  isSessionActive: (claims: IntrospectionClaims) => Promise<boolean>;
  now?: () => number;
  audit?: (event: IntrospectionAuditEvent) => void;
}

interface BetterAuthJwtApi {
  verifyJWT: (input: { body: { token: string } }) => Promise<{ payload: unknown | null }>;
}

function compareSecrets(provided: string, expected: string): boolean {
  // Comparing fixed-length digests prevents length-dependent timing behavior.
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function readMachineBearer(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function normalizeClaims(payload: unknown, now: number): IntrospectionClaims | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const claims = payload as Record<string, unknown>;
  if (
    typeof claims.sub !== "string" || claims.sub.length === 0 ||
    typeof claims.iss !== "string" || claims.iss.length === 0 ||
    typeof claims.aud !== "string" || claims.aud.length === 0 ||
    typeof claims.exp !== "number" || !Number.isInteger(claims.exp) || claims.exp <= now ||
    typeof claims.jti !== "string" || claims.jti.length === 0
  ) {
    return null;
  }

  return {
    sub: claims.sub,
    iss: claims.iss,
    aud: claims.aud,
    exp: claims.exp,
    jti: claims.jti,
  };
}

function defaultAudit(event: IntrospectionAuditEvent): void {
  // Never include the submitted JWT, Authorization header, or user data.
  console.info(JSON.stringify(event));
}

export function createPostgresSessionActivityChecker(
  database: Pick<Pool, "query">,
): (claims: IntrospectionClaims) => Promise<boolean> {
  return async (claims) => {
    const result = await database.query(
      `SELECT 1
         FROM auth.sessions AS session
         JOIN auth.users AS users ON users.id = session."userId"
        WHERE session.id = $1
          AND session."userId" = $2
          AND session."expiresAt" > CURRENT_TIMESTAMP
          AND users.disabled = FALSE
        LIMIT 1`,
      [claims.jti, claims.sub],
    );
    return result.rowCount === 1;
  };
}

export function createBetterAuthJwtVerifier(
  api: BetterAuthJwtApi,
): (token: string) => Promise<unknown | null> {
  return async (token) => (await api.verifyJWT({ body: { token } })).payload;
}

export function createTokenIntrospectionParseErrorHandler(): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    const errorType = error && typeof error === "object" && "type" in error
      ? String(error.type)
      : "";

    if (
      (req.path === "/token/introspect" || req.path === "/token/introspect/") &&
      (errorType === "entity.parse.failed" || errorType === "entity.too.large")
    ) {
      const status = errorType === "entity.too.large" ? 413 : 400;
      return res.status(status).set("Cache-Control", "no-store").json({ error: "invalid_request" });
    }

    return next(error);
  };
}

export const tokenIntrospectionRateLimitHandler: RequestHandler = (_req, res) => {
  res.status(429).set("Cache-Control", "no-store").json({ error: "rate_limited" });
};

export function createTokenIntrospectionHandler(
  dependencies: TokenIntrospectionDependencies,
): RequestHandler {
  const audit = dependencies.audit ?? defaultAudit;
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  const record = (outcome: IntrospectionAuditEvent["outcome"]): void => {
    try {
      audit({
        event: "token_introspection",
        clientId: dependencies.clientId,
        outcome,
      });
    } catch {
      // Audit transport failures must not expose token status or crash auth.
    }
  };

  return async (req, res) => {
    if (!dependencies.machineToken || dependencies.machineToken.length < MIN_MACHINE_TOKEN_LENGTH) {
      record("misconfigured");
      return res.status(503).set("Cache-Control", "no-store").json({ error: "service_unavailable" });
    }

    const providedMachineToken = readMachineBearer(req.get("authorization"));
    if (!providedMachineToken || !compareSecrets(providedMachineToken, dependencies.machineToken)) {
      record("unauthorized");
      return res.status(401).set("Cache-Control", "no-store").json({ error: "unauthorized" });
    }

    const body = req.body;
    if (
      !body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.token !== "string" || body.token.length === 0 || body.token.length > MAX_TOKEN_LENGTH
    ) {
      record("invalid_request");
      return res.status(400).set("Cache-Control", "no-store").json({ error: "invalid_request" });
    }

    try {
      const payload = await dependencies.verifyToken(body.token);
      const claims = normalizeClaims(payload, now());
      if (!claims || !await dependencies.isSessionActive(claims)) {
        record("inactive");
        return res.set("Cache-Control", "no-store").json({ active: false });
      }

      record("active");
      return res.set("Cache-Control", "private, max-age=30").json({
        active: true,
        ...claims,
      });
    } catch {
      // Verification and persistence failures fail closed without logging the JWT.
      record("inactive");
      return res.set("Cache-Control", "no-store").json({ active: false });
    }
  };
}
