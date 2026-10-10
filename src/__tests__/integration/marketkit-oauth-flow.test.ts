/**
 * REAL isolated OAuth 2.1 flow for the opt-in MarketKit provider.
 *
 * This is not a unit test of options: it stands up an actual Better Auth server
 * on the pinned `better-auth@1.7.7` + `@better-auth/oauth-provider@1.7.7` pair
 * with the REAL plugin built by this extension, then drives:
 *
 *   HTTP sign-up → authorize (PKCE S256) → authorization code → token endpoint
 *             → JWKS-verified identity → refresh grant → consent surface
 *
 * against the in-memory adapter (no network, no production database).
 *
 * REGRESSION HARDENING (this revision). The previous harness decoded the JWT
 * payload segment directly (`JSON.parse(Buffer.from(token.split(".")[1]…))`) and
 * only asserted `iss`/`aud`/present `sub`/`scope`. An unverified decode accepts a
 * token with ANY signature (including a forged one) as long as the middle segment
 * is well-formed — see evidence/red-gap-unverified-decode.log — so it never
 * proved the token was actually issued by this authorization server. Every
 * identity assertion below now VERIFIES the signature against the LIVE `/jwks`
 * endpoint with the real `jose` verifier, then asserts the exact fixture identity
 * (iss, aud, client_id, sub === the signed-up user id, scope, expiry).
 *
 * The global test setup mocks `better-auth`; this file unmocks it so the real
 * library runs.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import crypto from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";

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
const OTHER_REDIRECT = "https://evil.example/callback";
const RESOURCE = "https://mcp.marketkit.example";
const OTHER_RESOURCE = "https://other.marketkit.example";
const CLIENT_ID = "marketkit-mcp";
// `offline_access` is an explicit, configured MarketKit scope: the provider only
// issues a refresh token when the requested scope set contains it. It is part of
// the fixture scope set so the refresh grant can be exercised at all.
const SCOPES = ["mcp:tools", "mcp:artifacts:read", "offline_access"];

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
  socialProviders: { google: { clientId: 'bounded-google-fixture', clientSecret: 'bounded-not-a-real-secret', getUserInfo: async () => ({ user: { name: 'Browser Fixture', email: 'google-browser@marketkit.example', emailVerified: true }, data: { sub: 'google-fixture-user', name: 'Browser Fixture', email: 'google-browser@marketkit.example', email_verified: true, iss: 'https://accounts.google.com', aud: 'bounded-google-fixture', azp: 'bounded-google-fixture', iat: 1, exp: 9999999999, picture: '', given_name: 'Browser', family_name: 'Fixture', locale: 'en' } }) } },
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
 *
 * `skipConsent` is a parameter so the consent surface (which was previously
 * skipped entirely) is exercised when set to false.
 */
function seedClient(skipConsent = true) {
  (db.oauthClient as Record<string, unknown>[]).push({
    id: "mkc-1",
    clientId: CLIENT_ID,
    name: "MarketKit MCP",
    redirectUris: [REDIRECT],
    scopes: SCOPES,
    requirePKCE: true,
    skipConsent,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
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

/** Sign up a fresh user, returning both the session cookie and the user id. */
async function signUp(email: string): Promise<{ cookie: string; userId: string }> {
  const res = await auth.handler(
    new Request(`${BASE_URL}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Passw0rd!Passw0rd!!", name: "Flow" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: (res.headers.get("set-cookie") || "").split(";")[0], userId: body.user.id };
}

/** Sign in an existing user, returning a fresh session cookie. */
async function signIn(email: string): Promise<{ cookie: string }> {
  const res = await auth.handler(
    new Request(`${BASE_URL}/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Passw0rd!Passw0rd!!" }),
    }),
  );
  expect(res.status).toBe(200);
  return { cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

interface AuthorizeOptions {
  pkce?: boolean;
  redirectUri?: string;
  resource?: string;
  scope?: string;
  state?: string;
}

async function authorize(cookie: string, opts: AuthorizeOptions = {}) {
  const withPkce = opts.pkce ?? true;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${BASE_URL}/oauth2/authorize`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", opts.redirectUri ?? REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scope ?? SCOPES.join(" "));
  if (opts.resource !== "") url.searchParams.set("resource", opts.resource ?? RESOURCE);
  url.searchParams.set("state", opts.state ?? "flow-state");
  if (withPkce) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  const res = await auth.handler(new Request(url, { headers: { cookie } }));
  return { res, verifier };
}

async function token(body: Record<string, string>) {
  const res = await auth.handler(
    new Request(`${BASE_URL}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Exchange a code obtained from `authorize`. */
async function exchange(code: string, verifier: string, extra: Record<string, string> = {}) {
  return token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource: RESOURCE,
    ...extra,
  });
}

/**
 * Verify a signed access token against the LIVE `/jwks` endpoint of this
 * authorization server and return the verified payload. This is the assertion
 * the previous harness could not make: an unverified decode accepts a forged
 * signature, so every identity claim is checked only after real verification.
 */
async function verifyAgainstLiveJwks(accessToken: string): Promise<JWTPayload> {
  const jwksRes = await auth.handler(new Request(`${BASE_URL}/jwks`));
  expect(jwksRes.status).toBe(200);
  const jwks = (await jwksRes.json()) as { keys: unknown[] };
  expect(Array.isArray(jwks.keys)).toBe(true);
  expect(jwks.keys.length).toBeGreaterThan(0);
  const { payload } = await jwtVerify(accessToken, createLocalJWKSet(jwks as never), {
    issuer: BASE_URL,
    audience: RESOURCE,
    algorithms: ["RS256"],
  });
  return payload;
}

function sortedScopes(value: unknown): string[] {
  return String(value).split(" ").filter(Boolean).sort();
}

/** Obtain a fresh code + verifier for the shared client. */
async function codeFor(cookie: string, opts: AuthorizeOptions = {}) {
  const { res, verifier } = await authorize(cookie, opts);
  const code = new URL(res.headers.get("location") || "").searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code as string, verifier };
}

import { createBoothwrightBrowserHandler } from '../../lib/boothwright-browser.js';
const browser = createBoothwrightBrowserHandler({ enabled: true, baseURL: BASE_URL, secret: 'k'.repeat(48), config: CONFIG, auth });

it('browser rejects unsigned continuation before rendering', async () => {
 expect((await browser(new Request(`${BASE_URL}/login?client_id=${CLIENT_ID}`)))?.status).toBe(400);
});

it('real provider anonymous login continuation is preserved, consent is explicit and session/CSRF bound', async () => {
 seedClient(false);
 const { res, verifier } = await authorize('');
 const login = new URL(res.headers.get('location')!, BASE_URL);
 expect(login.pathname).toBe('/login');
 const page = await browser(new Request(login));
 expect(page?.status).toBe(200);
 const html = await page!.text();
 expect(html).toContain('Continue with Google');
 const loginTicket = html.match(/name="ticket" value="([^"]+)"/)![1];
 const loginCookie = page!.headers.get('set-cookie')!.split(';')[0];
 const google = await browser(new Request(`${BASE_URL}/login`, { method:'POST', headers:{ origin:BASE_URL, cookie:loginCookie, 'content-type':'application/x-www-form-urlencoded' }, body:new URLSearchParams({ticket:loginTicket}) }));
 expect(google?.status).toBe(303);
 const googleURL = new URL(google!.headers.get('location')!);
 expect(googleURL.origin).toBe('https://accounts.google.com');
 expect(googleURL.searchParams.get('redirect_uri')).toBe(BASE_URL+'/callback/google');
 const unsigned = new URL(login); unsigned.searchParams.set('returnTo','https://evil.example');
 expect((await browser(new Request(unsigned)))?.status).toBe(400);
 vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now()+86400000);
 try { expect((await browser(new Request(login)))?.status).toBe(400); } finally { vi.useRealTimers(); }
 const tampered = new URL(login); tampered.searchParams.set('resource', OTHER_RESOURCE);
 expect((await browser(new Request(tampered)))?.status).toBe(400);
 // Bounded Google token/profile fixtures; exercise the real callback/state hook without network.
 const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const endpoint = String(input instanceof Request ? input.url : input);
  if (endpoint !== 'https://oauth2.googleapis.com/token') throw new Error('Unexpected fixture network: '+endpoint);
  return new Response(JSON.stringify({access_token:'bounded-google-access',token_type:'Bearer',expires_in:3600}),{headers:{'content-type':'application/json'}});
 });
 let callback: Response;
 try {
  callback = await auth.handler(new Request(`${BASE_URL}/callback/google?code=bounded-code&state=${googleURL.searchParams.get('state')}`, {headers:{cookie:google!.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),accept:'text/html'}}));
 } finally { network.mockRestore(); }
 expect(callback.status).toBe(302);
 const session = { cookie: callback.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ') };
 const consent = new URL(callback.headers.get('location')!, BASE_URL);
 expect(consent.pathname).toBe('/consent');
 expect((await browser(new Request(consent)))?.status).toBe(401);
 const rendered = await browser(new Request(consent, { headers: { cookie: session.cookie } }));
 expect(rendered?.status).toBe(200);
 const consentHtml = await rendered!.text();
 const ticket = consentHtml.match(/name="ticket" value="([^"]+)"/)![1];
 const csrfCookie = rendered!.headers.get('set-cookie')!.split(';')[0];
 const post = (decision: string, cookie: string) => browser(new Request(`${BASE_URL}/consent`, { method: 'POST', headers: { origin: BASE_URL, cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket, decision }) }));
 expect((await post('allow', session.cookie))?.status).toBe(403);
 const otherSession = await signUp('other-browser@marketkit.example');
 expect((await post('allow', `${otherSession.cookie}; ${csrfCookie}`))?.status).toBe(403);
 const forged = new Request(`${BASE_URL}/consent`, {method:'POST',headers:{origin:BASE_URL,cookie:`${session.cookie}; ${csrfCookie}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket:ticket.slice(0,-1)+'x',decision:'allow'})});
 expect((await browser(forged))?.status).toBe(400);
 const denied = await post('deny', `${session.cookie}; ${csrfCookie}`);
 expect(denied?.headers.get('location')).toContain('error=access_denied');
 const accepted = await post('allow', `${session.cookie}; ${csrfCookie}`);
 expect(accepted?.status).toBe(303);
 const code = new URL(accepted!.headers.get('location')!).searchParams.get('code')!;
 const exchanged = await exchange(code, verifier);
 expect(exchanged.status).toBe(200);
 const claims = await verifyAgainstLiveJwks(exchanged.body.access_token as string);
 const identity = await auth.handler(new Request(`${BASE_URL}/get-session`,{headers:{cookie:session.cookie}}));
 expect(claims.sub).toBe(((await identity.json()) as {user:{id:string}}).user.id);
 db.oauthClient.length = 0; db.oauthClientResource.length = 0; db.oauthResource.length = 0;
});

describe("marketkit oauth provider — REAL isolated flow (better-auth 1.7.7)", () => {
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    seedClient(true);
    ({ cookie, userId } = await signUp("flow@marketkit.example"));
  });

  it("issues an authorization code bound to the explicit resource", async () => {
    const { res } = await authorize(cookie);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith(REDIRECT)).toBe(true);
    expect(new URL(loc).searchParams.get("code")).toBeTruthy();
  });

  it("verifies the issued token against the LIVE JWKS and pins the exact identity", async () => {
    const { code, verifier } = await codeFor(cookie);
    const { status, body } = await exchange(code, verifier);
    expect(status).toBe(200);
    const accessToken = body.access_token as string;
    expect(typeof accessToken).toBe("string");
    expect(accessToken.split(".")).toHaveLength(3);

    // Signature verified against the authorization server's real JWKS endpoint.
    const claims = await verifyAgainstLiveJwks(accessToken);
    expect(claims.iss).toBe(BASE_URL);
    expect(claims.aud).toBe(RESOURCE);
    // The OAuth CLIENT (RP) identity is explicit and correct.
    expect(claims.client_id).toBe(CLIENT_ID);
    // The subject is the ACTUAL signed-up user, not merely "present".
    expect(claims.sub).toBe(userId);
    // Expiry is present, numeric, and in the future.
    expect(typeof claims.exp).toBe("number");
    expect(claims.exp as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // Granted scopes equal the requested/configured set.
    expect(sortedScopes(claims.scope)).toEqual([...SCOPES].sort());
  });

  it("keeps the token subject stable across two independent logins of the same user", async () => {
    // Same email → same user id → same `sub`, even though the token is freshly
    // signed (distinct jti/iat/sid) each time. A random or client-derived subject
    // would break artifact ownership; this proves the identity is the durable user.
    const first = await codeFor(cookie);
    const firstClaims = await verifyAgainstLiveJwks(
      (await exchange(first.code, first.verifier)).body.access_token as string,
    );

    // Second login: sign in again with the SAME email → same user identity.
    const again = await signIn("flow@marketkit.example");
    expect(again.cookie).not.toBe(cookie);
    const second = await codeFor(again.cookie);
    const secondClaims = await verifyAgainstLiveJwks(
      (await exchange(second.code, second.verifier)).body.access_token as string,
    );

    expect(firstClaims.sub).toBe(userId);
    expect(secondClaims.sub).toBe(userId);
    expect(firstClaims.sub).toBe(secondClaims.sub);
    // Fresh tokens are distinct objects (distinct jti), but share the same sub.
    expect(firstClaims.jti).not.toBe(secondClaims.jti);
  });

  it("refuses an authorize request that omits PKCE", async () => {
    const { res } = await authorize(cookie, { pkce: false });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("error=invalid_request");
    expect(loc.toLowerCase()).toContain("pkce");
  });

  it("refuses a token exchange with the WRONG PKCE verifier", async () => {
    const { code } = await codeFor(cookie);
    const wrong = crypto.randomBytes(32).toString("base64url");
    const { status, body } = await exchange(code, wrong);
    expect(status).toBe(401);
    expect(body.error).toBe("invalid_request");
    expect(String(body.error_description).toLowerCase()).toContain("verification failed");
  });

  it("refuses a token exchange with an EXACT-but-wrong redirect_uri", async () => {
    const { code, verifier } = await codeFor(cookie);
    // Same length-class, https, but not the registered URI: must be rejected by
    // exact match (no prefix/substring acceptance).
    const { status, body } = await exchange(code, verifier, { redirect_uri: OTHER_REDIRECT });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(String(body.error_description).toLowerCase()).toContain("redirect_uri");
  });

  it("refuses a token exchange for a resource that was never authorized", async () => {
    const { code, verifier } = await codeFor(cookie);
    const { status, body } = await exchange(code, verifier, { resource: OTHER_RESOURCE });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_target");
  });

  it("refuses to authorize against an unconfigured cross-resource", async () => {
    const { res } = await authorize(cookie, { resource: OTHER_RESOURCE });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toContain("error=invalid_target");
  });

  it("issues a refresh token and rejects a REPLAY of a rotated refresh token", async () => {
    const { code, verifier } = await codeFor(cookie);
    const issued = await exchange(code, verifier);
    expect(issued.status).toBe(200);
    const refreshToken = issued.body.refresh_token as string;
    expect(typeof refreshToken).toBe("string");

    const rotated = await token({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      resource: RESOURCE,
    });
    expect(rotated.status).toBe(200);
    expect(typeof rotated.body.access_token).toBe("string");

    // Replaying the original (now rotated) refresh token is rejected.
    const replay = await token({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      resource: RESOURCE,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });

  it("NARROWS scopes on refresh but REFUSES to widen them", async () => {
    const { code, verifier } = await codeFor(cookie);
    const issued = await exchange(code, verifier);
    const refreshToken = issued.body.refresh_token as string;

    // Narrowing to a subset of the originally granted scopes is allowed.
    const narrowed = await token({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: "mcp:tools",
      resource: RESOURCE,
    });
    expect(narrowed.status).toBe(200);
    const narrowedClaims = await verifyAgainstLiveJwks(narrowed.body.access_token as string);
    expect(sortedScopes(narrowedClaims.scope)).toEqual(["mcp:tools"]);

    // Requesting a scope that was never granted must be refused (no widening).
    const fresh = await codeFor(cookie);
    const freshIssued = await exchange(fresh.code, fresh.verifier);
    const widened = await token({
      grant_type: "refresh_token",
      refresh_token: freshIssued.body.refresh_token as string,
      client_id: CLIENT_ID,
      scope: "mcp:tools mcp:admin",
      resource: RESOURCE,
    });
    expect(widened.status).toBe(400);
    expect(widened.body.error).toBe("invalid_scope");
  });

  it("refuses a refresh token presented against a cross-resource", async () => {
    const { code, verifier } = await codeFor(cookie);
    const issued = await exchange(code, verifier);
    const { status, body } = await token({
      grant_type: "refresh_token",
      refresh_token: issued.body.refresh_token as string,
      client_id: CLIENT_ID,
      resource: OTHER_RESOURCE,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_target");
  });

  it("routes through the explicit consent surface when skipConsent is false", async () => {
    // A second client row that requires consent: the authorize request must NOT
    // jump straight back to the callback with a code; it must land on the
    // configured consent page instead.
    (db.oauthClient as Record<string, unknown>[]).push({
      id: "mkc-consent",
      clientId: "marketkit-mcp-consent",
      name: "MarketKit MCP (consent)",
      redirectUris: [REDIRECT],
      scopes: SCOPES,
      requirePKCE: true,
      skipConsent: false,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      disabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The consent client must be linked to the resource, else the authorize
    // request short-circuits with invalid_target before reaching consent.
    (db.oauthClientResource as Record<string, unknown>[]).push({
      id: "mkcr-consent",
      clientId: "marketkit-mcp-consent",
      resourceId: RESOURCE,
      createdAt: new Date(),
    });
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(`${BASE_URL}/oauth2/authorize`);
    url.searchParams.set("client_id", "marketkit-mcp-consent");
    url.searchParams.set("redirect_uri", REDIRECT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("resource", RESOURCE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await auth.handler(new Request(url, { headers: { cookie } }));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    // Consent gate hit: a site-relative consent page, not the redirect callback.
    expect(loc.startsWith("/consent")).toBe(true);
    expect(loc.startsWith(REDIRECT)).toBe(false);
  });
});
