import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationsRoot = path.resolve(process.cwd(), "migrations");

describe("auth migration image", () => {
  it("uses Liquibase JDBC for readiness and schema creation without apk", () => {
    const dockerfile = fs.readFileSync(path.join(migrationsRoot, "Dockerfile"), "utf8");
    const entrypoint = fs.readFileSync(
      path.join(migrationsRoot, "docker-entrypoint.sh"),
      "utf8",
    );

    expect(dockerfile).not.toContain("apk add");
    expect(dockerfile).not.toContain("postgresql-client");
    expect(entrypoint).not.toContain("pg_isready");
    expect(entrypoint).not.toContain("psql");
    expect(entrypoint).toContain("liquibase-bootstrap.properties");
    expect(entrypoint).toContain('execute-sql --sql="SELECT 1;"');
    expect(entrypoint).toContain(
      'execute-sql --sql="CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS liquibase;"',
    );
    expect(entrypoint).not.toMatch(/--password[= ]/);
  });
});
