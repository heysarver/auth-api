/**
 * Discovery-surface probe: confirm the real 1.7.7 provider serves OAuth 2.1 /
 * OIDC discovery metadata with the configured resource as issuer, and advertises
 * the authorization / token / jwks endpoints. Read-only; in-memory adapter.
 */
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { memoryAdapter } from "better-auth/adapters/memory";
import { oauthProvider } from "@better-auth/oauth-provider";
import { createMarketKitOAuthProviderOptions } from "./dist/lib/marketkit-oauth-provider.js";

const BASE_URL = "http://localhost:3002";
const RESOURCE = "https://mcp.marketkit.example";
const CLIENT_ID = "marketkit-mcp";
const SCOPES = ["mcp:tools", "mcp:artifacts:read", "offline_access"];
const REDIRECT = "https://mcp.marketkit.example/callback";

const db = {};
for (const m of ["user","users","session","sessions","account","accounts","verification","verifications","jwks",
  "oauthClient","oauthResource","oauthClientResource","oauthRefreshToken","oauthAccessToken","oauthConsent","oauthClientAssertion"]) db[m] = [];

const auth = betterAuth({
  database: memoryAdapter(db),
  baseURL: BASE_URL,
  basePath: "/",
  secret: "k".repeat(48),
  emailAndPassword: { enabled: true },
  user: { modelName: "users" },
  session: { modelName: "sessions" },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  plugins: [
    jwt({ jwks: { modelName: "jwks", keyPairConfig: { alg: "RS256" } } }),
    oauthProvider(createMarketKitOAuthProviderOptions({
      clientId: CLIENT_ID, clientName: "MarketKit MCP", redirectUris: [REDIRECT],
      allowedOrigins: ["https://mcp.marketkit.example"], resource: RESOURCE, scopes: SCOPES,
      consentPage: "/consent", loginPage: "/login",
    })),
  ],
});

const CANDIDATES = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/oauth2/.well-known/oauth-authorization-server",
  "/oauth2/.well-known/openid-configuration",
];

async function main() {
  let found = null;
  for (const path of CANDIDATES) {
    const res = await auth.handler(new Request(`${BASE_URL}${path}`));
    if (res.status === 200) {
      found = { path, body: await res.json() };
      break;
    }
  }
  if (!found) {
    console.log("DISCOVERY: FAIL - no metadata document served at any probed path");
    process.exit(1);
  }
  console.log("DISCOVERY_PATH:", found.path);
  const b = found.body;
  console.log("issuer:", b.issuer);
  console.log("authorization_endpoint:", b.authorization_endpoint);
  console.log("token_endpoint:", b.token_endpoint);
  console.log("jwks_uri:", b.jwks_uri);
  console.log("code_challenge_methods_supported:", JSON.stringify(b.code_challenge_methods_supported));
  console.log("scopes_supported:", JSON.stringify(b.scopes_supported));
  console.log("resource_parameter:", JSON.stringify(b.resource_parameter ?? b.authorization_response_iss_parameter_supported));
  console.log("grant_types_supported:", JSON.stringify(b.grant_types_supported));

  const okIssuer = b.issuer === BASE_URL;
  const okEndpoints = [b.authorization_endpoint, b.token_endpoint, b.jwks_uri]
    .every((u) => typeof u === "string" && u.startsWith(BASE_URL));
  const okPkce = Array.isArray(b.code_challenge_methods_supported) && b.code_challenge_methods_supported.includes("S256");
  console.log("\nCHECK issuer==BASE_URL:", okIssuer);
  console.log("CHECK endpoints under BASE_URL:", okEndpoints);
  console.log("CHECK S256 advertised:", okPkce);
  console.log(okIssuer && okEndpoints && okPkce ? "\nDISCOVERY: PASS" : "\nDISCOVERY: FAIL");
  process.exit(okIssuer && okEndpoints && okPkce ? 0 : 1);
}
main().catch((e) => { console.error("DISCOVERY ERROR:", e.message); process.exit(1); });
