import { describe, expect, it } from "vitest";
import { postgresPoolMaximum } from "../../lib/database-config.js";

describe("postgresPoolMaximum", () => {
  it("keeps the compatibility default", () => {
    expect(postgresPoolMaximum(undefined, "development")).toBe(20);
  });

  it("accepts the bounded production reservation", () => {
    expect(postgresPoolMaximum("10", "production")).toBe(10);
  });

  it.each(["0", "21", "1.5", "not-a-number"])("rejects %s", (value) => {
    expect(() => postgresPoolMaximum(value, "development")).toThrow(
      "POSTGRES_POOL_MAX must be an integer from 1 to 20",
    );
  });

  it("fails closed when the production limit is absent or widened", () => {
    expect(() => postgresPoolMaximum(undefined, "production")).toThrow(
      "POSTGRES_POOL_MAX=10 is required in production",
    );
    expect(() => postgresPoolMaximum("20", "production")).toThrow(
      "POSTGRES_POOL_MAX must equal 10 in production",
    );
  });
});
