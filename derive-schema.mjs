import { oauthProvider } from "@better-auth/oauth-provider";

const plugin = oauthProvider({
  scopes: ["mcp:tools"],
  resources: [{ identifier: "https://mcp.marketkit.example", allowedScopes: ["mcp:tools"] }],
  clientRegistrationRequirePKCE: true,
  allowDynamicClientRegistration: false,
  consentPage: "/consent",
  loginPage: "/login",
});

console.log("PLUGIN_ID", plugin.id);
console.log("PLUGIN_VERSION", plugin.version);
console.log("SCHEMA_KEYS", JSON.stringify(Object.keys(plugin.schema || {})));

// Print each model's modelName and field -> type map + required flags.
for (const [key, model] of Object.entries(plugin.schema || {})) {
  const fields = {};
  for (const [f, def] of Object.entries(model.fields || {})) {
    fields[f] = { type: String(def.type), required: !!def.required };
  }
  console.log("MODEL", key, "modelName=", model.modelName, JSON.stringify(fields));
}
