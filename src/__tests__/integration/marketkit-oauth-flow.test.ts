/**
 * REAL isolated OAuth 2.1 flow for the opt-in MarketKit provider.
 *
 * This is not a unit test of options: it stands up an actual Better Auth server
 * on the pinned `better-auth@1.7.7` + `@better-auth/oauth-provider@1.7.7` pair
 * with the REAL plugin built by this extension, then drives:
 *
 *   HTTP sign-up → authorize (PKCE S256) → authorization code → token endpoint
 *
 * against the in-memory adapter (no network, no production database) and asserts
 * the issued access token is bound to the configured RFC 8707 resource/audience,
 * carries the granted scope, and has a subject. It also proves PKCE is required.
 *
 * The global test setup mocks `better-auth`; this file unmocks it so the real
 * library runs.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import crypto from "node:crypto";

vi.unmock("better-auth");
vi.unmock("better-auth/plugins");

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import {
  createMarketKitOAuthProviderOptions,
  type MarketKitOAuthConfig,
} from "../../lib/marketkit-oauth-provider.js";

const BASE_URL = "http://localhost:3002";
const REDIRECT = "https://mcp.marketkit.example/callback";
const RESOURCE = "https://mcp.marketkit.example";
const CLIENT_ID = "marketkit-mcp";
const SCOPES = ["mcp:tools", "mcp:artifacts:read"];

const CONFIG: MarketKitOAuthConfig = {
  clientId: CLIENT_ID,
  clientName: "MarketKit MCP",
  redirectUris: [REDIRECT],
  allowedOrigins: ["https://mcp.marketkit.example"],
  resource: RESOURCE,
  scopes: SCOPES,
  consentPage: "/consent",
  loginPage: "/login",
};

function freshDb() {
  const rows: Record<string, unknown[]> = {};
  for (const m of [
    // Both the model key and the modelName (plural) key must exist so the
    // memory adapter can resolve lookups for either.
    "user", "users", "session", "sessions", "account", "accounts",
    "verification", "verifications", "jwks",
    "oauthClient", "oauthResource", "oauthClientResource",
    "oauthRefreshToken", "oauthAccessToken", "oauthConsent", "oauthClientAssertion",
  ]) rows[m] = [];
  return rows;
}

const db = freshDb();

// Build the REAL auth server using the SAME options object the extension produces.
const auth = betterAuth({
  database: memoryAdapter(db),
  baseURL: BASE_URL,
  basePath: "/",
  secret: "k".repeat(48),
  emailAndPassword: { enabled: true },
  user: { modelName: "users" },
  session: { modelName: "sessions", storeSessionInDatabase: true },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  plugins: [
    jwt({ jwks: { modelName: "jwks", keyPairConfig: { alg: "RS256" } } }),
    oauthProvider(createMarketKitOAuthProviderOptions(CONFIG)),
  ],
});

/**
 * Seed the oauthClient rows directly into the memory store. The auth server's
 * resource seeding creates the oauthResource row; we create the client + link.
 */
function seedClient() {
  // The oauthResource row is keyed by `identifier`; the client link references
  // it. Insert rows in the shape the memory adapter stores for each model.
  (db.oauthClient as Record<string, unknown>[]).push({
    id: "mkc-1",
    clientId: CLIENT_ID,
    name: "MarketKit MCP",
    redirectUris: [REDIRECT],
    scopes: SCOPES,
    requirePKCE: true,
    skipConsent: true,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  (db.oauthResource as Record<string, unknown>[]).push({
    id: "mkr-1",
    identifier: RESOURCE,
    name: "MarketKit MCP Resource",
    allowedScopes: SCOPES,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  (db.oauthClientResource as Record<string, unknown>[]).push({
    id: "mkcr-1",
    clientId: CLIENT_ID,
    resourceId: RESOURCE,
    createdAt: new Date(),
  });
}

async function signUpAndGetCookie(): Promise<string> {
  const res = await auth.handler(
    new Request(`${BASE_URL}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "flow@marketkit.example", password: "Passw0rd!Passw0rd!!", name: "Flow" }),
    }),
  );
  expect(res.status).toBe(200);
  if (res.status !== 200) console.error("signup body", res.status, await res.clone().text());
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

async function authorize(cookie: string, withPkce: boolean) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${BASE_URL}/oauth2/authorize`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("resource", RESOURCE);
  url.searchParams.set("state", "flow-state");
  if (withPkce) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  const res = await auth.handler(new Request(url, { headers: { cookie } }));
  return { res, verifier };
}

describe("marketkit oauth provider — REAL isolated flow (better-auth 1.7.7)", () => {
  let cookie: string;

  beforeAll(async () => {
    seedClient();
    cookie = await signUpAndGetCookie();
  });

  it("issues an authorization code bound to the explicit resource", async () => {
    const { res } = await authorize(cookie, true);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith(REDIRECT)).toBe(true);
    expect(new URL(loc).searchParams.get("code")).toBeTruthy();
  });

  it("exchanges a PKCE code for a resource-bound access token", async () => {
    const { res, verifier } = await authorize(cookie, true);
    const code = new URL(res.headers.get("location") || "").searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await auth.handler(
      new Request(`${BASE_URL}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tok = (await tokenRes.json()) as { access_token: string; scope: string };
    expect(tok.access_token).toBeTruthy();
    const claims = JSON.parse(Buffer.from(tok.access_token.split(".")[1], "base64url").toString());
    expect(claims.aud).toBe(RESOURCE);
    expect(claims.iss).toBe(BASE_URL);
    expect(claims.sub).toBeTruthy();
    expect(String(claims.scope).split(" ").sort()).toEqual([...SCOPES].sort());
  });

  it("refuses an authorize request that omits PKCE", async () => {
    const { res } = await authorize(cookie, false);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("error=invalid_request");
    expect(loc.toLowerCase()).toContain("pkce");
  });
});
