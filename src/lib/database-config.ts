export function postgresPoolMaximum(
  raw: string | undefined,
  environment: string | undefined,
): number {
  if (environment === "production" && raw === undefined) {
    throw new Error("POSTGRES_POOL_MAX=10 is required in production");
  }
  const value = raw === undefined ? 20 : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error("POSTGRES_POOL_MAX must be an integer from 1 to 20");
  }
  if (environment === "production" && value !== 10) {
    throw new Error("POSTGRES_POOL_MAX must equal 10 in production");
  }
  return value;
}
