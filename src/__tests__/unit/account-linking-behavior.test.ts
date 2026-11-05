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
  const createSession = vi.fn().mockResolvedValue({
    id: "session-123",
    userId: localUser.id,
    token: "session-token",
    expiresAt: new Date("2026-08-08T12:00:00.000Z"),
    createdAt: now,
    updatedAt: now,
  });

  const credentialAccount = {
    id: "credential-account-123",
    accountId: localUser.id,
    providerId: "credential",
    userId: localUser.id,
    createdAt: now,
    updatedAt: now,
  };

  // better-auth 1.7 replaced the single `findOAuthUser` lookup with two steps:
  // an account-key ownership check, then an email lookup. Both are modelled
  // here so the test exercises the real decision path rather than a stub.
  const findAccountOwnerByKey = vi.fn().mockResolvedValue(null);
  const findUserByEmail = vi.fn().mockImplementation(async (email: string) => {
    if (email.toLowerCase() !== localUser.email) {
      return null;
    }
    return { user: localUser, accounts: [credentialAccount] };
  });

  // 1.7 registers a new OAuth user inside a transaction, so the adapter must
  // expose one. The callback runs inline here; the internal-adapter doubles
  // below are plain mocks and never read the transaction-scoped adapter.
  const adapter = {
    transaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };

  const context = {
    context: {
      options: {
        account: {
          accountLinking: matchingVerifiedEmailAccountLinking,
        },
      },
      adapter,
      trustedProviders: [],
      // 1.7 reads `socialProviders` to decide whether a provider requires email
      // verification. An empty list keeps that decision on the account policy.
      socialProviders: [],
      internalAdapter: {
        findAccountOwnerByKey,
        findUserByEmail,
        linkAccount,
        createUser,
        createAccount,
        createSession,
        updateUser,
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
      // 1.7 destructures `id` off userInfo and discards it: the account key now
      // comes from accountSubject. It stays here because the input type still
      // requires it.
      id: "google-user-456",
      name: "Google Profile Name",
      email,
      emailVerified,
      image: "https://example.com/google-avatar.png",
      createdAt: now,
      updatedAt: now,
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

    const result = await handleOAuthUserInfo(
      harness.context,
      googleOptions(),
    );

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

    const result = await handleOAuthUserInfo(
      harness.context,
      googleOptions(),
    );

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
    expect(harness.findAccountOwnerByKey).toHaveBeenCalledWith({
      providerId: "google",
      accountId: "google-user-456",
    });
    expect(harness.findUserByEmail).toHaveBeenCalledWith(
      "different@example.com",
      { includeAccounts: true },
    );
    expect(harness.linkAccount).not.toHaveBeenCalled();
    expect(harness.createUser).toHaveBeenCalledOnce();
    expect(harness.createAccount).toHaveBeenCalledOnce();
  });
});
