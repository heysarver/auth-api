import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import type { EnabledWorkloadConfig } from "./workload-config.js";
import { verifyDpopProof } from "./workload-dpop.js";
import { WorkloadError } from "./workload-errors.js";
import type { WorkloadGrantInput, WorkloadStore } from "./workload-store.js";
import type { IssuedWorkloadToken, WorkloadTokenClaims, WorkloadTokenInput } from "./workload-token.js";

const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_GRANT_LENGTH = 256;

type WorkloadOperation = "create_grant" | "exchange" | "introspect" | "renew" | "revoke";
type WorkloadOutcome = "conflict" | "inactive" | "invalid" | "success" | "unauthorized";

interface WorkloadAuditEvent {
  event: "workload_identity";
  operation: WorkloadOperation;
  outcome: WorkloadOutcome;
  principalId?: string;
  jti?: string;
}

export interface WorkloadRouteDependencies {
  config: EnabledWorkloadConfig;
  store: WorkloadStore;
  issueToken: (input: WorkloadTokenInput) => Promise<IssuedWorkloadToken>;
  verifyToken: (token: string) => Promise<WorkloadTokenClaims | null>;
  limiter?: RequestHandler;
  audit?: (event: WorkloadAuditEvent) => void;
}

function defaultAudit(event: WorkloadAuditEvent): void {
  // Only lifecycle identifiers and reason codes are logged. Credentials and proofs are never included.
  console.info(JSON.stringify(event));
}

function record(
  audit: (event: WorkloadAuditEvent) => void,
  operation: WorkloadOperation,
  outcome: WorkloadOutcome,
  identifiers: Pick<WorkloadAuditEvent, "principalId" | "jti"> = {},
): void {
  try {
    audit({ event: "workload_identity", operation, outcome, ...identifiers });
  } catch {
    // Audit transport failure must not change the authorization decision.
  }
}

function compareSecrets(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function bearerCredential(request: Request, expected: string): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(request.get("authorization") ?? "");
  return Boolean(match?.[1] && compareSecrets(match[1], expected));
}

function dpopAccessToken(request: Request): string | null {
  const match = /^DPoP ([^\s]+)$/i.exec(request.get("authorization") ?? "");
  const token = match?.[1];
  if (!token || token.length > MAX_ACCESS_TOKEN_LENGTH) {
    return null;
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function uuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function parseGrantInput(body: unknown): WorkloadGrantInput {
  if (!isRecord(body) || (body.mode !== "create" && body.mode !== "rotate")) {
    throw new WorkloadError("invalid_request", 400);
  }
  const expectedKeys = body.mode === "create" ? ["cnf_jkt", "mode"] : ["cnf_jkt", "mode", "principal_id"];
  if (!hasExactKeys(body, expectedKeys)) {
    throw new WorkloadError("invalid_request", 400);
  }
  const jkt = typeof body.cnf_jkt === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.cnf_jkt)
    ? body.cnf_jkt
    : null;
  if (!jkt) {
    throw new WorkloadError("invalid_request", 400);
  }
  if (body.mode === "create") {
    return { mode: "create", jkt };
  }
  const principalId = uuid(body.principal_id);
  if (!principalId) {
    throw new WorkloadError("invalid_request", 400);
  }
  return { mode: "rotate", principalId, jkt };
}

function parseGrant(body: unknown): string {
  if (!isRecord(body) || !hasExactKeys(body, ["grant"])) {
    throw new WorkloadError("invalid_request", 400);
  }
  if (typeof body.grant !== "string" || body.grant.length === 0 || body.grant.length > MAX_GRANT_LENGTH) {
    throw new WorkloadError("invalid_request", 400);
  }
  return body.grant;
}

function parseToken(body: unknown): string {
  if (!isRecord(body) || !hasExactKeys(body, ["token"])) {
    throw new WorkloadError("invalid_request", 400);
  }
  if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > MAX_ACCESS_TOKEN_LENGTH) {
    throw new WorkloadError("invalid_request", 400);
  }
  return body.token;
}

function parseRevocation(body: unknown): { jti?: string; principalId?: string } {
  if (!isRecord(body) || Object.keys(body).length !== 1) {
    throw new WorkloadError("invalid_request", 400);
  }
  if ("jti" in body) {
    const jti = uuid(body.jti);
    if (!jti) {
      throw new WorkloadError("invalid_request", 400);
    }
    return { jti };
  }
  if ("principal_id" in body) {
    const principalId = uuid(body.principal_id);
    if (!principalId) throw new WorkloadError("invalid_request", 400);
    return { principalId };
  }
  throw new WorkloadError("invalid_request", 400);
}

function tokenInput(claims: WorkloadTokenClaims): WorkloadTokenInput {
  return {
    principalId: claims.sub,
    jkt: claims.cnf.jkt,
  };
}

function tokenResponse(issued: IssuedWorkloadToken, config: EnabledWorkloadConfig) {
  return {
    access_token: issued.token,
    token_type: "DPoP",
    expires_in: config.tokenTtlSeconds,
  };
}

function sendError(error: unknown, operation: WorkloadOperation, audit: (event: WorkloadAuditEvent) => void, response: Parameters<RequestHandler>[1]): void {
  const workloadError = error instanceof WorkloadError
    ? error
    : new WorkloadError(operation === "introspect" ? "inactive_token" : "service_unavailable", operation === "introspect" ? 200 : 503);
  const outcome: WorkloadOutcome = workloadError.code === "unauthorized"
    ? "unauthorized"
    : workloadError.code === "conflict"
      ? "conflict"
      : workloadError.code === "inactive_token"
        ? "inactive"
        : "invalid";
  record(audit, operation, outcome);

  if (operation === "introspect" && workloadError.code === "inactive_token") {
    response.status(200).set("Cache-Control", "no-store").json({ active: false });
    return;
  }
  const publicCode = workloadError.code === "inactive_token" ? "invalid_token" : workloadError.code;
  if (workloadError.code === "invalid_dpop_proof") {
    response.set("WWW-Authenticate", 'DPoP error="invalid_dpop_proof"');
  }
  response.status(workloadError.status).set("Cache-Control", "no-store").json({ error: publicCode });
}

export function createWorkloadRouter(dependencies: WorkloadRouteDependencies): Router {
  const router = Router();
  const audit = dependencies.audit ?? defaultAudit;
  if (dependencies.limiter) {
    router.use(dependencies.limiter);
  }

  router.post("/workload/principals/grants", async (request, response) => {
    try {
      if (!bearerCredential(request, dependencies.config.operatorToken)) {
        throw new WorkloadError("unauthorized", 401);
      }
      const input = parseGrantInput(request.body);
      const grant = await dependencies.store.createGrant(input, dependencies.config.grantTtlSeconds);
      record(audit, "create_grant", "success", { principalId: grant.principalId });
      response.status(201).set("Cache-Control", "no-store").json({
        principal_id: grant.principalId,
        grant: grant.grant,
        expires_at: grant.expiresAt.toISOString(),
      });
    } catch (error) {
      sendError(error, "create_grant", audit, response);
    }
  });

  router.post("/workload/token", async (request, response) => {
    try {
      const grantSecret = parseGrant(request.body);
      const grant = await dependencies.store.readGrant(grantSecret);
      const proof = await verifyDpopProof({
        proof: request.get("dpop"),
        method: "POST",
        url: dependencies.config.tokenEndpointUrl,
        expectedJkt: grant.jkt,
        clockSkewSeconds: dependencies.config.dpopClockSkewSeconds,
      });
      const issued = await dependencies.issueToken({
        principalId: grant.principalId,
        jkt: grant.jkt,
      });
      await dependencies.store.consumeGrantAndIssue(grantSecret, proof, issued.claims);
      record(audit, "exchange", "success", { principalId: issued.claims.sub, jti: issued.claims.jti });
      response.set("Cache-Control", "no-store").json(tokenResponse(issued, dependencies.config));
    } catch (error) {
      sendError(error, "exchange", audit, response);
    }
  });

  router.post("/workload/token/renew", async (request, response) => {
    try {
      if (!isRecord(request.body) || !hasExactKeys(request.body, [])) {
        throw new WorkloadError("invalid_request", 400);
      }
      const accessToken = dpopAccessToken(request);
      if (!accessToken) {
        throw new WorkloadError("inactive_token", 401);
      }
      const current = await dependencies.verifyToken(accessToken);
      if (!current) {
        throw new WorkloadError("inactive_token", 401);
      }
      const proof = await verifyDpopProof({
        proof: request.get("dpop"),
        method: "POST",
        url: dependencies.config.renewalEndpointUrl,
        expectedJkt: current.cnf.jkt,
        accessToken,
        clockSkewSeconds: dependencies.config.dpopClockSkewSeconds,
      });
      const issued = await dependencies.issueToken(tokenInput(current));
      await dependencies.store.rotateToken(current, proof, issued.claims);
      record(audit, "renew", "success", { principalId: current.sub, jti: issued.claims.jti });
      response.set("Cache-Control", "no-store").json(tokenResponse(issued, dependencies.config));
    } catch (error) {
      sendError(error, "renew", audit, response);
    }
  });

  router.post("/workload/token/introspect", async (request, response) => {
    try {
      if (!bearerCredential(request, dependencies.config.introspectionToken)) {
        throw new WorkloadError("unauthorized", 401);
      }
      const token = parseToken(request.body);
      const claims = await dependencies.verifyToken(token);
      if (!claims || !await dependencies.store.isTokenActive(claims)) {
        throw new WorkloadError("inactive_token", 200);
      }
      record(audit, "introspect", "success", { principalId: claims.sub, jti: claims.jti });
      // Workload revocation is immediate, so even active introspection responses must not be cached.
      response.set("Cache-Control", "no-store").json({ active: true, ...claims });
    } catch (error) {
      sendError(error, "introspect", audit, response);
    }
  });

  router.post("/workload/revoke", async (request, response) => {
    try {
      if (!bearerCredential(request, dependencies.config.operatorToken)) {
        throw new WorkloadError("unauthorized", 401);
      }
      const input = parseRevocation(request.body);
      await dependencies.store.revoke(input);
      record(audit, "revoke", "success", { principalId: input.principalId, jti: input.jti });
      response.set("Cache-Control", "no-store").status(204).send();
    } catch (error) {
      sendError(error, "revoke", audit, response);
    }
  });

  return router;
}

export function createWorkloadParseErrorHandler(): ErrorRequestHandler {
  return (error: unknown, request, response, next) => {
    const errorType = error && typeof error === "object" && "type" in error ? String(error.type) : "";
    if (
      request.path.startsWith("/workload/") &&
      (errorType === "entity.parse.failed" || errorType === "entity.too.large")
    ) {
      const status = errorType === "entity.too.large" ? 413 : 400;
      return response.status(status).set("Cache-Control", "no-store").json({ error: "invalid_request" });
    }
    return next(error);
  };
}
