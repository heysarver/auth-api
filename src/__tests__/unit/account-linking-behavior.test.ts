import { handleOAuthUserInfo } from "better-auth/oauth2";
import { describe, expect, it, vi } from "vitest";

import { matchingVerifiedEmailAccountLinking } from "../../lib/account-linking-config.js";

const now = new Date("2026-08-07T12:00:00.000Z");

function createLocalUser(emailVerified = true) {
  return {
    id: "local-user-123",
    name: "Existing Morning Shepherd User",
    email: "existing@example.com",
    emailVerified,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createHarness(localEmailVerified = true) {
  const localUser = createLocalUser(localEmailVerified);
  const linkAccount = vi.fn().mockResolvedValue({ id: "linked-account-123" });
  const createUser = vi.fn();
  const createAccount = vi.fn();
  const updateUser = vi.fn();
  const updateAccount = vi.fn();
  const createSession = vi.fn().mockResolvedValue({
    id: "session-123",
    userId: localUser.id,
    token: "session-token",
    expiresAt: new Date("2026-08-08T12:00:00.000Z"),
    createdAt: now,
    updatedAt: now,
  });

  // better-auth >= 1.7 internalAdapter surface used by handleOAuthUserInfo.
  // No pre-existing google account → findAccountOwnerByKey returns null, so the
  // flow falls through to the email lookup.
  const findAccountOwnerByKey = vi.fn().mockResolvedValue(null);
  const findAccountByKey = vi.fn().mockResolvedValue(null);
  const findUserById = vi.fn().mockResolvedValue(localUser);
  const findUserByEmail = vi.fn().mockResolvedValue({
    user: localUser,
    accounts: [
      {
        id: "credential-account-123",
        accountId: localUser.id,
        providerId: "credential",
        userId: localUser.id,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

  const context = {
    context: {
      options: {
        account: {
          accountLinking: matchingVerifiedEmailAccountLinking,
        },
      },
      baseURL: "http://localhost:3002",
      adapter: {
        // better-auth >= 1.7 wraps user+account creation in a transaction.
        transaction: async (fn: (trx: unknown) => unknown) => fn({}),
      },
      trustedProviders: [],
      socialProviders: [],
      internalAdapter: {
        findAccountOwnerByKey,
        findAccountByKey,
        findUserById,
        findUserByEmail,
        linkAccount,
        createUser,
        createAccount,
        createSession,
        updateUser,
        updateAccount,
      },
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
    },
  } as unknown as Parameters<typeof handleOAuthUserInfo>[0];

  return {
    context,
    localUser,
    findAccountOwnerByKey,
    findUserByEmail,
    linkAccount,
    createUser,
    createAccount,
    updateUser,
  };
}

function googleOptions(email = "existing@example.com", emailVerified = true) {
  return {
    userInfo: {
      id: "google-user-456",
      name: "Google Profile Name",
      email,
      emailVerified,
      image: "https://example.com/google-avatar.png",
    },
    account: {
      accountId: "google-user-456",
      providerId: "google",
    },
    callbackURL: "/briefs/today",
  };
}

describe("Better Auth matching-email linking behavior", () => {
  it("links verified Google to the existing verified user", async () => {
    const harness = createHarness();

    const result = await handleOAuthUserInfo(harness.context, googleOptions());

    expect(result.error).toBeNull();
    expect(result.data?.user.id).toBe(harness.localUser.id);
    expect(harness.linkAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "google",
        accountId: "google-user-456",
        userId: harness.localUser.id,
      }),
    );
    expect(harness.createUser).not.toHaveBeenCalled();
    expect(harness.updateUser).not.toHaveBeenCalled();
  });

  it("rejects linking when Google does not verify the email", async () => {
    const harness = createHarness();

    const result = await handleOAuthUserInfo(
      harness.context,
      googleOptions("existing@example.com", false),
    );

    expect(result).toMatchObject({ error: "account not linked", data: null });
    expect(harness.linkAccount).not.toHaveBeenCalled();
    expect(harness.createUser).not.toHaveBeenCalled();
  });

  it("rejects linking when the existing local email is not verified", async () => {
    const harness = createHarness(false);

    const result = await handleOAuthUserInfo(harness.context, googleOptions());

    expect(result).toMatchObject({ error: "account not linked", data: null });
    expect(harness.linkAccount).not.toHaveBeenCalled();
    expect(harness.createUser).not.toHaveBeenCalled();
  });

  it("does not link a Google identity with a different email", async () => {
    const harness = createHarness();
    const differentUser = {
      ...createLocalUser(),
      id: "different-user-789",
      email: "different@example.com",
    };
    harness.findUserByEmail.mockResolvedValue(null);
    harness.createUser.mockResolvedValue(differentUser);
    harness.createAccount.mockResolvedValue({
      id: "google-account-789",
      accountId: "google-user-456",
      providerId: "google",
      userId: differentUser.id,
      createdAt: now,
      updatedAt: now,
    });

    const result = await handleOAuthUserInfo(
      harness.context,
      googleOptions("different@example.com"),
    );

    expect(result.error).toBeNull();
    expect(result.data?.user.id).toBe(differentUser.id);
    expect(harness.findUserByEmail).toHaveBeenCalledWith(
      "different@example.com",
      { includeAccounts: true },
    );
    expect(harness.linkAccount).not.toHaveBeenCalled();
    expect(harness.createUser).toHaveBeenCalledOnce();
  });
});
