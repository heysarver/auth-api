import { describe, expect, it } from "vitest";
import { auth } from "../../lib/auth.js";

interface JwtPluginConfig {
  id: string;
  options: {
    jwt: {
      audience: string;
      definePayload: (session: { session: { id: string } }) => Record<string, unknown>;
    };
  };
}

interface CapturedAuthConfig {
  emailAndPassword: { revokeSessionsOnPasswordReset: boolean };
  session: { storeSessionInDatabase: boolean };
  plugins: JwtPluginConfig[];
  databaseHooks: { session: { create: { before: unknown } } };
}

describe("durable bearer revocation configuration", () => {
  const config = auth as unknown as CapturedAuthConfig;

  it("persists sessions and revokes them after credential reset", () => {
    expect(config.session.storeSessionInDatabase).toBe(true);
    expect(config.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("issues a minimal session-bound JWT revision", () => {
    const jwtPlugin = config.plugins.find((plugin) => plugin.id === "jwt");

    expect(jwtPlugin).toBeDefined();
    expect(jwtPlugin?.options.jwt.audience).toBe("http://localhost:3002");
    expect(jwtPlugin?.options.jwt.definePayload({ session: { id: "session-revision" } })).toEqual({
      jti: "session-revision",
    });
  });

  it("installs a session-creation guard for administrative disablement", () => {
    expect(config.databaseHooks.session.create.before).toEqual(expect.any(Function));
  });
});
