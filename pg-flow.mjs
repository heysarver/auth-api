/**
 * REAL PostgreSQL end-to-end: the pinned better-auth@1.7.7 +
 * @better-auth/oauth-provider@1.7.7 pair, the plugin built by the extension's own
 * option factory, driving sign-up -> authorize (S256 PKCE) -> token -> JWKS verify
 * against an ISOLATED PostgreSQL whose schema came from the opt-in migration 007.
 *
 * This proves two load-bearing contract properties that the in-memory adapter
 * cannot:
 *  1. The 1.7.7 runtime resolves the SINGULAR quoted table names created by 007
 *     (auth."oauthClient", auth."oauthAccessToken", ...). A pluralised table would
 *     make better-auth's schema check throw.
 *  2. `string[]` fields are written to JSONB columns (a TEXT[] column would raise
 *     `malformed array literal` on the first oauthAccessToken/oauthRefreshToken write).
 */
import crypto from "node:crypto";
import { Pool } from "pg";
import { createLocalJWKSet, jwtVerify } from "jose";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { createMarketKitOAuthProviderOptions } from "./dist/lib/marketkit-oauth-provider.js";

const BASE_URL = "http://localhost:3002";
const REDIRECT = "https://mcp.marketkit.example/callback";
const RESOURCE = "https://mcp.marketkit.example";
const CLIENT_ID = "marketkit-mcp";
const SCOPES = ["mcp:tools", "mcp:artifacts:read", "offline_access"];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=auth",
});

const CONFIG = {
  clientId: CLIENT_ID,
  clientName: "MarketKit MCP",
  redirectUris: [REDIRECT],
  allowedOrigins: ["https://mcp.marketkit.example"],
  resource: RESOURCE,
  scopes: SCOPES,
  consentPage: "/consent",
  loginPage: "/login",
};

const auth = betterAuth({
  database: pool,
  baseURL: BASE_URL,
  basePath: "/",
  secret: "k".repeat(48),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  user: { modelName: "users" },
  session: { modelName: "sessions" },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  plugins: [
    jwt({ jwks: { modelName: "jwks", keyPairConfig: { alg: "RS256" } } }),
    oauthProvider(createMarketKitOAuthProviderOptions(CONFIG)),
  ],
});

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ok -", msg);
}

async function main() {
  const email = `pgflow-${Date.now()}@marketkit.example`;

  // 1. Sign up through the real HTTP handler -> real INSERT into auth."users".
  const up = await auth.handler(
    new Request(`${BASE_URL}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Passw0rd!Passw0rd!!", name: "Flow" }),
    }),
  );
  assert(up.status === 200, `sign-up status 200 (got ${up.status})`);
  const { user } = await up.json();
  const cookie = (up.headers.get("set-cookie") || "").split(";")[0];
  console.log("  user id:", user.id);

  // 2. Seed the oauthClient row directly into the JSONB tables. The provider
  //    AUTO-SEEDS oauthResource from config (its own insert into the real table
  //    proves the singular-name/JSONB resolution). We look the resource id up and
  //    link the client to it.
  await pool.query(
    `INSERT INTO auth."oauthClient" ("id","clientId","name","redirectUris","scopes","requirePKCE","skipConsent","tokenEndpointAuthMethod","grantTypes","responseTypes","disabled","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,TRUE,TRUE,'none',$6::jsonb,$7::jsonb,FALSE,now(),now())
     ON CONFLICT ("clientId") DO NOTHING`,
    ["mkc-1", CLIENT_ID, "MarketKit MCP", JSON.stringify([REDIRECT]), JSON.stringify(SCOPES),
     JSON.stringify(["authorization_code", "refresh_token"]), JSON.stringify(["code"])],
  );
  const resRow = await pool.query(
    `SELECT "identifier" FROM auth."oauthResource" WHERE "identifier" = $1`,
    [RESOURCE],
  );
  assert(resRow.rowCount === 1, "provider auto-seeded oauthResource from config into the real table");
  await pool.query(
    `INSERT INTO auth."oauthClientResource" ("id","clientId","resourceId","createdAt")
     VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING`,
    ["mkcr-1", CLIENT_ID, RESOURCE],
  );
  console.log("  ok - seeded oauthClient + link; provider auto-seeded oauthResource (JSONB)");

  // 3. Authorize with real S256 PKCE.
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authzUrl = new URL(`${BASE_URL}/oauth2/authorize`);
  authzUrl.searchParams.set("client_id", CLIENT_ID);
  authzUrl.searchParams.set("redirect_uri", REDIRECT);
  authzUrl.searchParams.set("response_type", "code");
  authzUrl.searchParams.set("scope", SCOPES.join(" "));
  authzUrl.searchParams.set("resource", RESOURCE);
  authzUrl.searchParams.set("state", "pg-state");
  authzUrl.searchParams.set("code_challenge", challenge);
  authzUrl.searchParams.set("code_challenge_method", "S256");
  const ar = await auth.handler(new Request(authzUrl, { headers: { cookie } }));
  assert(ar.status === 302, `authorize 302 (got ${ar.status})`);
  const code = new URL(ar.headers.get("location") || "").searchParams.get("code");
  assert(!!code, "authorization code issued to the registered redirect");

  // 4. Token exchange -> writes JSONB scopes into auth."oauthAccessToken".
  const tr = await auth.handler(
    new Request(`${BASE_URL}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    }),
  );
  const tb = await tr.json();
  assert(tr.status === 200, `token exchange 200 (got ${tr.status})`);
  assert(typeof tb.access_token === "string", "access_token issued");
  assert(typeof tb.refresh_token === "string", "refresh_token issued (offline_access)");

  // 5. Verify the signature against the LIVE /jwks endpoint with real jose.
  const jwksRes = await auth.handler(new Request(`${BASE_URL}/jwks`));
  assert(jwksRes.status === 200, "JWKS endpoint 200");
  const jwks = await jwksRes.json();
  const { payload } = await jwtVerify(tb.access_token, createLocalJWKSet(jwks), {
    issuer: BASE_URL,
    audience: RESOURCE,
    algorithms: ["RS256"],
  });
  assert(payload.iss === BASE_URL, `iss == ${BASE_URL}`);
  assert(payload.aud === RESOURCE, `aud == ${RESOURCE}`);
  assert(payload.client_id === CLIENT_ID, `client_id == ${CLIENT_ID}`);
  assert(payload.sub === user.id, `sub == signed-up user id (${user.id})`);
  assert(typeof payload.exp === "number" && payload.exp * 1000 > Date.now(), "exp in the future");
  assert(
    String(payload.scope).split(" ").filter(Boolean).sort().join(" ") === [...SCOPES].sort().join(" "),
    "granted scope == configured scope set",
  );

  // 6. Prove the DB actually stored JSONB array columns (not TEXT[]). In 1.7.7 the
  //    access token is a stateless signed JWT; the refresh token IS persisted, with
  //    JSONB `scopes`/`resources`. A TEXT[] column would have raised
  //    `malformed array literal` on this insert.
  const row = await pool.query(
    `SELECT jsonb_typeof("scopes") AS jt, jsonb_typeof("resources") AS rt
       FROM auth."oauthRefreshToken" LIMIT 1`,
  );
  assert(row.rowCount === 1, "an oauthRefreshToken row was persisted");
  assert(row.rows[0].jt === "array", `refresh scopes column is a JSONB array (got ${row.rows[0].jt})`);
  assert(row.rows[0].rt === "array", `refresh resources column is a JSONB array (got ${row.rows[0].rt})`);

  // 7. Refresh replay: rotate, then replay the old token.
  const rotated = await auth.handler(
    new Request(`${BASE_URL}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tb.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }).toString(),
    }),
  );
  assert(rotated.status === 200, "refresh grant 200");
  const replay = await auth.handler(
    new Request(`${BASE_URL}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tb.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }).toString(),
    }),
  );
  const replayBody = await replay.json();
  assert(replay.status === 400 && replayBody.error === "invalid_grant", "rotated refresh token replay rejected");

  console.log("\nPOSTGRES-FLOW: PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("\nPOSTGRES-FLOW: FAIL:", e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
