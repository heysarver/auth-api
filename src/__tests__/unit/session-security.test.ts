import { describe, expect, it, vi } from "vitest";
import { createDisabledUserSessionGuard } from "../../lib/session-security.js";

describe("disabled-user session guard", () => {
  it("allows session creation for an enabled user", async () => {
    const query = vi.fn(async () => ({ rows: [{ disabled: false }] }));
    const guard = createDisabledUserSessionGuard({ query } as never);

    await expect(guard({ userId: "enabled-user" })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      "SELECT disabled FROM auth.users WHERE id = $1 LIMIT 1",
      ["enabled-user"],
    );
  });

  it("rejects every new session while a user is disabled", async () => {
    const query = vi.fn(async () => ({ rows: [{ disabled: true }] }));
    const guard = createDisabledUserSessionGuard({ query } as never);

    await expect(guard({ userId: "disabled-user" })).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: expect.objectContaining({ code: "USER_DISABLED" }),
    });
  });
});
