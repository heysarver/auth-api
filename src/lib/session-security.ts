import { APIError } from "better-auth/api";
import type { Pool } from "pg";

export interface SessionCandidate {
  userId: string;
}

export function createDisabledUserSessionGuard(database: Pick<Pool, "query">) {
  return async (session: SessionCandidate): Promise<void> => {
    const result = await database.query(
      "SELECT disabled FROM auth.users WHERE id = $1 LIMIT 1",
      [session.userId],
    );

    if (result.rows[0]?.disabled === true) {
      throw APIError.from("FORBIDDEN", {
        code: "USER_DISABLED",
        message: "Account unavailable",
      });
    }
  };
}
