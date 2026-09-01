import { describe, expect, it } from "vitest";
import { postgresPoolMaximum } from "../../lib/database-config.js";

describe("postgresPoolMaximum", () => {
  it("keeps the compatibility default", () => {
    expect(postgresPoolMaximum(undefined)).toBe(20);
  });

  it("accepts the bounded production reservation", () => {
    expect(postgresPoolMaximum("10")).toBe(10);
  });

  it.each(["0", "21", "1.5", "not-a-number"])("rejects %s", (value) => {
    expect(() => postgresPoolMaximum(value)).toThrow(
      "POSTGRES_POOL_MAX must be an integer from 1 to 20",
    );
  });
});
