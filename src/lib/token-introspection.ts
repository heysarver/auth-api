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
  /**
   * `rate_limited` is recorded by the limiter, before the handler runs, so a
   * throttled burst is visible in the audit trail. Without it a rejected
   * request left no trace at all: the control plane saw its introspection
   * refused, told the founder their session had failed, and nothing anywhere
   * said the identity service had shed load.
   */
  outcome:
    | "active"
    | "inactive"
    | "invalid_request"
    | "misconfigured"
    | "unauthorized"
    | "rate_limited";
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

/**
 * The limiter's refusal, recorded where the other outcomes are recorded.
 *
 * The limiter runs before the handler, so it cannot use the handler's own
 * `record`. This emits the same event shape to the same place, which is what
 * makes a throttled burst countable next to the requests it refused.
 *
 * Deliberately a separate factory from `tokenIntrospectionRateLimitHandler`
 * below. That constant is shared by the workload limiter, so building the audit
 * into it would report a workload refusal as a token-introspection event and
 * change a response this module does not own.
 */
export function createTokenIntrospectionRateLimitHandler(options: {
  clientId: string;
  audit?: (event: IntrospectionAuditEvent) => void;
}): RequestHandler {
  const audit = options.audit ?? defaultAudit;
  return (_req, res) => {
    try {
      audit({
        event: "token_introspection",
        clientId: options.clientId,
        outcome: "rate_limited",
      });
    } catch {
      // Audit transport failures must not change the refusal.
    }
    res
      .status(429)
      .set("Cache-Control", "no-store")
      // A refused caller needs to know when to come back. The window is one
      // minute, so a second is the honest floor rather than a guess.
      .set("Retry-After", "1")
      .json({ error: "rate_limited" });
  };
}

/**
 * The shared limiter refusal, unchanged for every existing consumer.
 *
 * The workload limiter uses this too, so its response is frozen: same status,
 * same cache header, same body as before the introspection route gained an
 * audited variant.
 */
export const tokenIntrospectionRateLimitHandler: RequestHandler = (_req, res) => {
  res.status(429).set("Cache-Control", "no-store").json({ error: "rate_limited" });
};

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
