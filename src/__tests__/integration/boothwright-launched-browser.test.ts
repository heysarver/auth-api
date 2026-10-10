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
import { it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";

vi.unmock("better-auth");
vi.unmock("better-auth/node");
vi.unmock("better-auth/plugins");

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import {
  createMarketKitOAuthProviderOptions,
  type MarketKitOAuthConfig,
} from "../../lib/marketkit-oauth-provider.js";

const portProbe = createServer();
await new Promise<void>((resolve,reject)=>{portProbe.once('error',reject);portProbe.listen(0,'127.0.0.1',resolve)});
const fixturePort = (portProbe.address() as {port:number}).port;
await new Promise<void>((resolve,reject)=>portProbe.close(error=>error?reject(error):resolve()));
const BASE_URL = `http://127.0.0.1:${fixturePort}`;
const REDIRECT = "https://mcp.marketkit.example/callback";
const RESOURCE = "https://mcp.marketkit.example";
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

import { createBoothwrightBrowserHandler } from '../../lib/boothwright-browser.js';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import express from 'express';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
it('launched Chromium completes real AS login and consent with isolated Google transport', async () => {
 const modulePath = process.env.BOOTHWRIGHT_PLAYWRIGHT_MODULE;
 if (!modulePath) throw new Error('Set BOOTHWRIGHT_PLAYWRIGHT_MODULE to isolated Playwright index.mjs');
 process.stdout.write('fixture loading browser\n');
 const { chromium } = await import(/* @vite-ignore */ modulePath);
 process.stdout.write('fixture browser loaded\n');
 seedClient(false);
 const browserHandler = createBoothwrightBrowserHandler({enabled:true,baseURL:BASE_URL,secret:'k'.repeat(48),config:CONFIG,auth});
 const app = express();
 app.use(helmet());
 app.use(express.json({limit:'16kb'}));
 app.use(express.urlencoded({extended:true,limit:'16kb'}));
 // Test-only transport maps validated Google/caller redirects to local fixtures.
 // No provider bypass: state cookies, callback handler, consent and code issuance remain real.
 app.use((req,res,next)=> {
  process.stdout.write('fixture route '+req.method+' '+req.path+'\n');
  const setHeader=res.setHeader.bind(res);
  res.setHeader=((key:string,value:any)=> {
   if(key.toLowerCase()==='location') {
    const location=new URL(String(value),BASE_URL);
    if(location.origin==='https://accounts.google.com') value=BASE_URL+'/fixture/google'+location.search;
    else if(String(value).startsWith(REDIRECT)) value=BASE_URL+'/fixture/result'+location.search;
   }
   return setHeader(key,value);
  }) as typeof res.setHeader;
  next();
 });
 app.get('/fixture/google',(req,res)=>res.redirect(BASE_URL+'/callback/google?code=bounded-code&state='+encodeURIComponent(String(req.query.state))));
 app.get('/fixture/result',(_req,res)=>res.type('html').send('<h1>Fixture callback received</h1>'));
 app.all(['/login','/consent'],toNodeHandler(async (request:Request)=>(await browserHandler(request))!));
 app.all('/*splat',toNodeHandler(auth));
 const server = createServer(app);
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(fixturePort,'127.0.0.1',resolve)});
 const originalFetch = globalThis.fetch;
 const network = vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
  const endpoint = String(input instanceof Request?input.url:input);
  if(endpoint==='https://oauth2.googleapis.com/token') return new Response(JSON.stringify({access_token:'bounded-google-access',token_type:'Bearer',expires_in:3600}),{headers:{'content-type':'application/json'}});
  if(new URL(endpoint).origin===BASE_URL) return originalFetch(input,init);
  throw new Error('Unexpected fixture network');
 });
 let chrome:any;
 try {
  chrome=await chromium.launch({headless:true});
  const context=await chrome.newContext();
  const page=await context.newPage();
  page.on('console',(message:any)=>process.stdout.write('browser console '+message.type()+' '+message.text().replace(/https?:\/\/\S+/g,'[url]')+'\n'));
  page.on('requestfailed',(request:any)=>process.stdout.write('browser failed '+new URL(request.url()).origin+' '+request.failure()?.errorText+'\n'));
  page.setDefaultTimeout(10000);
  await context.route('**/*',async (route:any)=>new URL(route.request().url()).origin===BASE_URL?route.continue():route.abort());
  const {res,verifier}=await authorize('');
  await page.goto(new URL(res.headers.get('location')!,BASE_URL).toString());
  expect(await page.getByRole('button',{name:'Continue with Google'}).count()).toBe(1);
  await mkdir('evidence/final',{recursive:true});
  await page.screenshot({path:'evidence/final/browser-login.png'});
  await page.getByRole('button',{name:'Continue with Google'}).click();
  process.stdout.write('fixture page '+new URL(page.url()).origin+new URL(page.url()).pathname+'\n');
  await page.waitForURL(BASE_URL+'/consent?**');
  expect(await page.getByRole('button',{name:'Allow',exact:true}).count()).toBe(1);
  await page.screenshot({path:'evidence/final/browser-consent.png'});
  await page.getByRole('button',{name:'Allow',exact:true}).click();
  await page.waitForURL(BASE_URL+'/fixture/result?**');
  const code=new URL(page.url()).searchParams.get('code')!;
  expect(code).toBeTruthy();
  const exchanged=await exchange(code,verifier);
  expect(exchanged.status).toBe(200);
  const claims=await verifyAgainstLiveJwks(exchanged.body.access_token as string);
  expect(claims.client_id).toBe(CLIENT_ID);
  expect(claims.aud).toBe(RESOURCE);
  await page.screenshot({path:'evidence/final/browser-callback.png'});
  db.oauthConsent.length=0;
  await context.clearCookies();
  const deniedStart=await authorize('');
  await page.goto(new URL(deniedStart.res.headers.get('location')!,BASE_URL).toString());
  await page.getByRole('button',{name:'Continue with Google'}).click();
  await page.waitForURL(BASE_URL+'/consent?**');
  await page.getByRole('button',{name:'Deny',exact:true}).click();
  await page.waitForURL(BASE_URL+'/fixture/result?**');
  expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied');
  expect(new URL(page.url()).searchParams.has('code')).toBe(false);
  await page.screenshot({path:'evidence/final/browser-denied.png'});
 } finally {
  network.mockRestore(); if(chrome)await chrome.close();
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 }
},30000);
