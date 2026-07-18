import { describe, expect, it } from "vitest";
import { loadWorkloadConfig } from "../../lib/workload-config.js";

const validEnv: NodeJS.ProcessEnv = {
  WORKLOAD_IDENTITY_ENABLED: "true",
  BETTER_AUTH_URL: "https://auth.example.test",
  WORKLOAD_JWT_AUDIENCE: "worker-audience",
  WORKLOAD_TOKEN_ENDPOINT_URL: "https://auth.example.test/workload/token",
  WORKLOAD_RENEWAL_ENDPOINT_URL: "https://auth.example.test/workload/token/renew",
  WORKLOAD_OPERATOR_BEARER_TOKEN: "operator-credential-that-is-long-enough",
  TOKEN_INTROSPECTION_BEARER_TOKEN: "introspection-credential-long-enough",
};

describe("workload configuration", () => {
  it("keeps the workload issuer disabled unless explicitly enabled", () => {
    expect(loadWorkloadConfig({})).toEqual({ enabled: false });
  });

  it("loads bounded consumer-neutral defaults", () => {
    expect(loadWorkloadConfig(validEnv)).toEqual({
      enabled: true,
      issuer: "https://auth.example.test",
      audience: "worker-audience",
      tokenEndpointUrl: "https://auth.example.test/workload/token",
      renewalEndpointUrl: "https://auth.example.test/workload/token/renew",
      operatorToken: validEnv.WORKLOAD_OPERATOR_BEARER_TOKEN,
      introspectionToken: validEnv.TOKEN_INTROSPECTION_BEARER_TOKEN,
      tokenTtlSeconds: 300,
      grantTtlSeconds: 300,
      dpopClockSkewSeconds: 60,
      rateLimitMax: 120,
    });
  });

  it.each([
    ["missing audience", { ...validEnv, WORKLOAD_JWT_AUDIENCE: "" }],
    ["short operator credential", { ...validEnv, WORKLOAD_OPERATOR_BEARER_TOKEN: "short" }],
    ["host-header-derived endpoint", { ...validEnv, WORKLOAD_TOKEN_ENDPOINT_URL: "" }],
    ["insecure remote endpoint", { ...validEnv, WORKLOAD_TOKEN_ENDPOINT_URL: "http://auth.example.test/workload/token" }],
    ["excessive token lifetime", { ...validEnv, WORKLOAD_TOKEN_TTL_SECONDS: "901" }],
    ["excessive clock skew", { ...validEnv, WORKLOAD_DPOP_CLOCK_SKEW_SECONDS: "61" }],
    ["invalid route rate limit", { ...validEnv, WORKLOAD_RATE_LIMIT_MAX: "0" }],
    ["human audience reuse", { ...validEnv, JWT_AUDIENCE: "worker-audience" }],
    ["wrong exchange path", { ...validEnv, WORKLOAD_TOKEN_ENDPOINT_URL: "https://auth.example.test/token" }],
    ["cross-origin exchange", { ...validEnv, WORKLOAD_TOKEN_ENDPOINT_URL: "https://tokens.example.test/workload/token" }],
    ["shared operator credential", {
      ...validEnv,
      WORKLOAD_OPERATOR_BEARER_TOKEN: validEnv.TOKEN_INTROSPECTION_BEARER_TOKEN,
    }],
  ])("fails closed for %s", (_label, env) => {
    expect(() => loadWorkloadConfig(env)).toThrow("misconfigured");
  });

  it("allows explicit localhost HTTP endpoints for local verification", () => {
    const config = loadWorkloadConfig({
      ...validEnv,
      BETTER_AUTH_URL: "http://localhost:3002",
      WORKLOAD_TOKEN_ENDPOINT_URL: "http://localhost:3002/workload/token",
      WORKLOAD_RENEWAL_ENDPOINT_URL: "http://localhost:3002/workload/token/renew",
    });
    expect(config.enabled && config.tokenEndpointUrl).toBe("http://localhost:3002/workload/token");
  });
});
