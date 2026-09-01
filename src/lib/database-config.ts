export function postgresPoolMaximum(raw: string | undefined): number {
  const value = raw === undefined ? 20 : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error("POSTGRES_POOL_MAX must be an integer from 1 to 20");
  }
  return value;
}
