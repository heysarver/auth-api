import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import type { EnabledWorkloadConfig } from "./workload-config.js";
import { verifyDpopProof } from "./workload-dpop.js";
import { WorkloadError } from "./workload-errors.js";
import type { WorkloadGrantInput, WorkloadStore } from "./workload-store.js";
import type { IssuedWorkloadToken, WorkloadTokenClaims, WorkloadTokenInput } from "./workload-token.js";

const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_GRANT_LENGTH = 256;
const MAX_GRANT_TTL_SECONDS = 24 * 60 * 60;

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
  signTokenClaims: (claims: WorkloadTokenClaims) => Promise<IssuedWorkloadToken>;
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

function parseGrantInput(
  body: unknown,
  defaultTtlSeconds: number,
): { input: WorkloadGrantInput; ttlSeconds: number } {
  if (!isRecord(body) || (body.mode !== "create" && body.mode !== "rotate")) {
    throw new WorkloadError("invalid_request", 400);
  }
  const includesExplicitTtl = "expires_in" in body;
  const includesRenewable = "renewable" in body;
  const expectedKeys = body.mode === "create"
    ? ["cnf_jkt", "mode", ...(includesExplicitTtl ? ["expires_in"] : []), ...(includesRenewable ? ["renewable"] : [])]
    : ["cnf_jkt", "mode", "principal_id", ...(includesExplicitTtl ? ["expires_in"] : []), ...(includesRenewable ? ["renewable"] : [])];
  if (!hasExactKeys(body, expectedKeys)) {
    throw new WorkloadError("invalid_request", 400);
  }
  const ttlSeconds = typeof body.expires_in === "number" &&
    Number.isInteger(body.expires_in) &&
    body.expires_in >= 60 &&
    body.expires_in <= MAX_GRANT_TTL_SECONDS
    ? body.expires_in
    : defaultTtlSeconds;
  if (body.expires_in !== undefined && ttlSeconds !== body.expires_in) {
    throw new WorkloadError("invalid_request", 400);
  }
  const jkt = typeof body.cnf_jkt === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.cnf_jkt)
    ? body.cnf_jkt
    : null;
  if (!jkt) {
    throw new WorkloadError("invalid_request", 400);
  }
  if (body.renewable !== undefined && typeof body.renewable !== "boolean") {
    throw new WorkloadError("invalid_request", 400);
  }
  const renewable = body.renewable === true;
  if (body.mode === "create") {
    return { input: { mode: "create", jkt, renewable }, ttlSeconds };
  }
  const principalId = uuid(body.principal_id);
  if (!principalId) {
    throw new WorkloadError("invalid_request", 400);
  }
  return { input: { mode: "rotate", principalId, jkt, renewable }, ttlSeconds };
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

function parseRenewalCredential(body: unknown): string {
  if (!isRecord(body) || !hasExactKeys(body, ["renewal_credential"])) {
    throw new WorkloadError("invalid_request", 400);
  }
  const credential = body.renewal_credential;
  if (typeof credential !== "string" || !/^wrc1_[A-Za-z0-9_-]{43}$/.test(credential)) {
    throw new WorkloadError("invalid_request", 400);
  }
  return credential;
}

function idempotencyKey(request: Request): string {
  const key = request.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new WorkloadError("invalid_request", 400);
  }
  return key;
}

function parseRevocation(body: unknown): { familyId?: string; jti?: string; principalId?: string } {
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
  if ("credential_family_id" in body) {
    const familyId = uuid(body.credential_family_id);
    if (!familyId) throw new WorkloadError("invalid_request", 400);
    return { familyId };
  }
  throw new WorkloadError("invalid_request", 400);
}

function tokenResponse(issued: IssuedWorkloadToken, config: EnabledWorkloadConfig) {
  return {
    access_token: issued.token,
    token_type: "DPoP",
    expires_in: config.tokenTtlSeconds,
  };
}

function renewableTokenResponse(
  issued: IssuedWorkloadToken,
  renewal: { credential: string; familyId: string; generation: number },
  config: EnabledWorkloadConfig,
) {
  return {
    ...tokenResponse(issued, config),
    renewal_credential: renewal.credential,
    renewal_credential_expires_in: config.renewalTtlSeconds,
    credential_family_id: renewal.familyId,
    renewal_generation: renewal.generation,
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
      const { input, ttlSeconds } = parseGrantInput(
        request.body,
        dependencies.config.grantTtlSeconds,
      );
      const grant = await dependencies.store.createGrant(input, ttlSeconds);
      record(audit, "create_grant", "success", { principalId: grant.principalId });
      response.status(201).set("Cache-Control", "no-store").json({
        principal_id: grant.principalId,
        grant: grant.grant,
        expires_at: grant.expiresAt.toISOString(),
        ...(grant.renewable ? { renewable: true } : {}),
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
      const renewal = await dependencies.store.consumeGrantAndIssue(grantSecret, proof, issued.claims);
      record(audit, "exchange", "success", { principalId: issued.claims.sub, jti: issued.claims.jti });
      response.set("Cache-Control", "no-store").json(
        renewal ? renewableTokenResponse(issued, renewal, dependencies.config) : tokenResponse(issued, dependencies.config),
      );
    } catch (error) {
      sendError(error, "exchange", audit, response);
    }
  });

  router.post("/workload/token/renew", async (request, response) => {
    try {
      const credential = parseRenewalCredential(request.body);
      const requestKey = idempotencyKey(request);
      const binding = await dependencies.store.readRenewalCredential(credential);
      const proof = await verifyDpopProof({
        proof: request.get("dpop"),
        method: "POST",
        url: dependencies.config.renewalEndpointUrl,
        expectedJkt: binding.jkt,
        clockSkewSeconds: dependencies.config.dpopClockSkewSeconds,
      });
      const candidate = await dependencies.issueToken({ principalId: binding.principalId, jkt: binding.jkt });
      const rotation = await dependencies.store.rotateRenewalCredential(
        credential,
        requestKey,
        proof,
        candidate.claims,
      );
      const issued = await dependencies.signTokenClaims(rotation.claims);
      record(audit, "renew", "success", { principalId: issued.claims.sub, jti: issued.claims.jti });
      response.set("Cache-Control", "no-store").json(renewableTokenResponse(issued, rotation, dependencies.config));
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
      const credentialFamilyId =
        await dependencies.store.credentialFamilyForToken(claims);
      record(audit, "introspect", "success", { principalId: claims.sub, jti: claims.jti });
      // Workload revocation is immediate, so even active introspection responses must not be cached.
      response.set("Cache-Control", "no-store").json({
        active: true,
        ...claims,
        ...(credentialFamilyId
          ? { credential_family_id: credentialFamilyId }
          : {}),
      });
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
