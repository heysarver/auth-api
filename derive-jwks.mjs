import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

// better-auth exposes table metadata through the auth instance's options/plugins.
// Dump the jwt plugin schema so we know the exact jwks columns 1.7.7 expects.
const p = jwt({ jwks: { modelName: "jwks", keyPairConfig: { alg: "RS256" } } });
console.log("JWT_PLUGIN_ID", p.id);
console.log("SCHEMA_KEYS", JSON.stringify(Object.keys(p.schema || {})));
for (const [key, model] of Object.entries(p.schema || {})) {
  const fields = {};
  for (const [f, def] of Object.entries(model.fields || {})) {
    fields[f] = { type: String(def.type), required: !!def.required };
  }
  console.log("MODEL", key, "modelName=", model.modelName, JSON.stringify(fields));
}
