import { WorkloadError } from "./workload-errors.js";

const MIN_SECRET_LENGTH = 32;

export interface DisabledWorkloadConfig {
  enabled: false;
}

export interface EnabledWorkloadConfig {
  enabled: true;
  issuer: string;
  audience: string;
  tokenEndpointUrl: string;
  renewalEndpointUrl: string;
  operatorToken: string;
  introspectionToken: string;
  tokenTtlSeconds: number;
  grantTtlSeconds: number;
  dpopClockSkewSeconds: number;
  rateLimitMax: number;
}

export type WorkloadConfig = DisabledWorkloadConfig | EnabledWorkloadConfig;

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new WorkloadError("misconfigured", 503);
  }
  return value;
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredValue(env, name);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new WorkloadError("misconfigured", 503);
  }
  return value;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WorkloadError("misconfigured", 503);
  }
  return value;
}

function canonicalUrl(value: string, expectedPath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkloadError("misconfigured", 503);
  }

  if (
    url.hash ||
    url.search ||
    url.username ||
    url.password ||
    url.pathname !== expectedPath ||
    (url.protocol !== "https:" && url.hostname !== "localhost")
  ) {
    throw new WorkloadError("misconfigured", 503);
  }
  return url.toString();
}

export function loadWorkloadConfig(env: NodeJS.ProcessEnv = process.env): WorkloadConfig {
  if (env.WORKLOAD_IDENTITY_ENABLED !== "true") {
    return { enabled: false };
  }

  const issuer = canonicalUrl(requiredValue(env, "BETTER_AUTH_URL"), "/");
  const audience = requiredValue(env, "WORKLOAD_JWT_AUDIENCE");
  const humanAudience = env.JWT_AUDIENCE?.trim() || issuer.replace(/\/$/, "");
  if (audience === humanAudience) {
    throw new WorkloadError("misconfigured", 503);
  }
  const tokenEndpointUrl = canonicalUrl(requiredValue(env, "WORKLOAD_TOKEN_ENDPOINT_URL"), "/workload/token");
  const renewalEndpointUrl = canonicalUrl(
    requiredValue(env, "WORKLOAD_RENEWAL_ENDPOINT_URL"),
    "/workload/token/renew",
  );
  if (
    new URL(tokenEndpointUrl).origin !== new URL(issuer).origin ||
    new URL(renewalEndpointUrl).origin !== new URL(issuer).origin
  ) {
    throw new WorkloadError("misconfigured", 503);
  }
  const operatorToken = requiredSecret(env, "WORKLOAD_OPERATOR_BEARER_TOKEN");
  const introspectionToken = requiredSecret(env, "TOKEN_INTROSPECTION_BEARER_TOKEN");
  if (operatorToken === introspectionToken) {
    throw new WorkloadError("misconfigured", 503);
  }

  return {
    enabled: true,
    issuer: issuer.replace(/\/$/, ""),
    audience,
    tokenEndpointUrl,
    renewalEndpointUrl,
    operatorToken,
    introspectionToken,
    tokenTtlSeconds: boundedInteger(env, "WORKLOAD_TOKEN_TTL_SECONDS", 300, 60, 900),
    grantTtlSeconds: boundedInteger(env, "WORKLOAD_GRANT_TTL_SECONDS", 300, 30, 300),
    dpopClockSkewSeconds: boundedInteger(env, "WORKLOAD_DPOP_CLOCK_SKEW_SECONDS", 60, 5, 60),
    rateLimitMax: boundedInteger(env, "WORKLOAD_RATE_LIMIT_MAX", 120, 1, 10_000),
  };
}
