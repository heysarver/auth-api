/**
 * LIVE container end-to-end: talk to the running marketkit/auth-api image over
 * HTTP only (no in-process imports), against the isolated PostgreSQL. Prove the
 * DEPLOYED authorization server issues a signed access token that verifies against
 * its own /jwks, bound to the configured resource/audience and the real user.
 */
import crypto from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";

const BASE = process.env.BASE || "http://localhost:13002";
const REDIRECT = "https://mcp.marketkit.example/callback";
const RESOURCE = "https://mcp.marketkit.example";
const CLIENT_ID = "marketkit-mcp";
const SCOPES = ["mcp:tools", "mcp:artifacts:read", "offline_access"];

function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); console.log("  ok -", m); }

async function main() {
  const email = `live-${Date.now()}@marketkit.example`;
  const up = await fetch(`${BASE}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ email, password: "Passw0rd!Passw0rd!!", name: "Live" }),
  });
  assert(up.status === 200, `live sign-up 200 (got ${up.status})`);
  const cookie = (up.headers.get("set-cookie") || "").split(";")[0];
  const { user } = await up.json();
  console.log("  live user id:", user.id);

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code",
    scope: SCOPES.join(" "), resource: RESOURCE, state: "live",
    code_challenge: challenge, code_challenge_method: "S256",
  });
  const az = await fetch(`${BASE}/oauth2/authorize?${q}`, { headers: { cookie }, redirect: "manual" });
  assert(az.status === 302 || az.status === 200, `live authorize 200/302 (got ${az.status})`);
  // The express/better-auth node handler returns either a 302 Location redirect or
  // a 200 JSON `{redirect:true,url}` envelope; accept both and read the callback URL.
  let loc = az.headers.get("location") || "";
  if (!loc) {
    const body = await az.json().catch(() => ({}));
    loc = body.url || "";
  }
  const code = new URL(loc).searchParams.get("code");
  assert(!!code && loc.startsWith(REDIRECT), "authorization code issued to the registered redirect");

  const tok = await fetch(`${BASE}/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT,
      client_id: CLIENT_ID, code_verifier: verifier, resource: RESOURCE,
    }).toString(),
  });
  const tb = await tok.json();
  assert(tok.status === 200 && typeof tb.access_token === "string", `live token 200 + access_token (got ${tok.status})`);

  const jwks = await (await fetch(`${BASE}/jwks`)).json();
  const { payload } = await jwtVerify(tb.access_token, createLocalJWKSet(jwks), {
    issuer: BASE, audience: RESOURCE, algorithms: ["RS256"],
  });
  assert(payload.iss === BASE, `iss == ${BASE}`);
  assert(payload.aud === RESOURCE, `aud == ${RESOURCE}`);
  assert(payload.client_id === CLIENT_ID, `client_id == ${CLIENT_ID}`);
  assert(payload.sub === user.id, `sub == live user id (${user.id})`);
  assert(
    String(payload.scope).split(" ").filter(Boolean).sort().join(" ") === [...SCOPES].sort().join(" "),
    "granted scope == configured set",
  );
  console.log("\nLIVE-CONTAINER-FLOW: PASS");
}

main().catch((e) => { console.error("\nLIVE-CONTAINER-FLOW: FAIL:", e.message); process.exit(1); });
