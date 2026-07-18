import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { WorkloadError } from "./workload-errors.js";
import type { WorkloadTokenClaims } from "./workload-token.js";

export type WorkloadGrantInput =
  | { mode: "create"; jkt: string }
  | { mode: "rotate"; principalId: string; jkt: string };

export interface WorkloadGrant {
  mode: "create" | "rotate";
  principalId: string;
  jkt: string;
  grant: string;
  expiresAt: Date;
}

export type WorkloadGrantRecord = Omit<WorkloadGrant, "grant">;

export interface WorkloadProofReplay {
  jkt: string;
  proofJti: string;
  expiresAt: Date;
}

export interface WorkloadStore {
  createGrant(input: WorkloadGrantInput, ttlSeconds: number): Promise<WorkloadGrant>;
  readGrant(grant: string): Promise<WorkloadGrantRecord>;
  consumeGrantAndIssue(grant: string, proof: WorkloadProofReplay, claims: WorkloadTokenClaims): Promise<void>;
  rotateToken(current: WorkloadTokenClaims, proof: WorkloadProofReplay, next: WorkloadTokenClaims): Promise<void>;
  isTokenActive(claims: WorkloadTokenClaims): Promise<boolean>;
  revoke(input: { jti?: string; principalId?: string }): Promise<number>;
}

interface GrantRow {
  mode: "create" | "rotate";
  principalId: string;
  cnfJkt: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function transaction<T>(database: Pick<Pool, "connect">, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function activeGrant(row: GrantRow | undefined, now = new Date()): GrantRow {
  if (!row || row.consumedAt || row.revokedAt || row.expiresAt <= now) {
    throw new WorkloadError("invalid_grant", 400);
  }
  return row;
}

async function insertReplay(client: PoolClient, proof: WorkloadProofReplay): Promise<void> {
  const replay = await client.query(
    `INSERT INTO auth.workload_dpop_replays (cnf_jkt, proof_jti, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [proof.jkt, proof.proofJti, proof.expiresAt],
  );
  if (replay.rowCount !== 1) {
    throw new WorkloadError("invalid_dpop_proof", 401);
  }
}

function assertClaimsMatchGrant(claims: WorkloadTokenClaims, grant: GrantRow): void {
  if (claims.sub !== grant.principalId || claims.cnf.jkt !== grant.cnfJkt) {
    throw new WorkloadError("invalid_grant", 400);
  }
}

export function createPostgresWorkloadStore(database: Pick<Pool, "connect" | "query">): WorkloadStore {
  return {
    async createGrant(input, ttlSeconds) {
      return transaction(database, async (client) => {
        const principalId = input.mode === "create" ? randomUUID() : input.principalId;
        // Serialize rotations and grant replacement for a stable issuer-owned principal.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [principalId]);
        const principal = await client.query<{ status: string }>(
          `SELECT status
             FROM auth.workload_principals
            WHERE principal_id = $1
            FOR UPDATE`,
          [principalId],
        );
        if (
          (input.mode === "create" && principal.rowCount !== 0) ||
          (input.mode === "rotate" && (principal.rowCount !== 1 || principal.rows[0]?.status !== "active"))
        ) {
          throw new WorkloadError("conflict", 409);
        }

        await client.query(
          `UPDATE auth.workload_grants
              SET revoked_at = CURRENT_TIMESTAMP
            WHERE principal_id = $1
              AND consumed_at IS NULL
              AND revoked_at IS NULL`,
          [principalId],
        );

        const grant = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        await client.query(
          `INSERT INTO auth.workload_grants
             (id, secret_hash, mode, principal_id, cnf_jkt, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), secretHash(grant), input.mode, principalId, input.jkt, expiresAt],
        );
        return { mode: input.mode, principalId, jkt: input.jkt, grant, expiresAt };
      });
    },

    async readGrant(grant) {
      const result = await database.query<GrantRow>(
        `SELECT mode,
                principal_id AS "principalId",
                cnf_jkt AS "cnfJkt",
                expires_at AS "expiresAt",
                consumed_at AS "consumedAt",
                revoked_at AS "revokedAt"
           FROM auth.workload_grants
          WHERE secret_hash = $1
          LIMIT 1`,
        [secretHash(grant)],
      );
      const row = activeGrant(result.rows[0]);
      return {
        mode: row.mode,
        principalId: row.principalId,
        jkt: row.cnfJkt,
        expiresAt: row.expiresAt,
      };
    },

    async consumeGrantAndIssue(grant, proof, claims) {
      await transaction(database, async (client) => {
        const grantHash = secretHash(grant);
        const binding = await client.query<{ principalId: string }>(
          `SELECT principal_id AS "principalId"
             FROM auth.workload_grants
            WHERE secret_hash = $1
            LIMIT 1`,
          [grantHash],
        );
        const principalId = binding.rows[0]?.principalId;
        if (!principalId) {
          throw new WorkloadError("invalid_grant", 400);
        }
        // Share the principal lock with rotation and revocation before locking mutable rows.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [principalId]);
        const result = await client.query<GrantRow>(
          `SELECT mode,
                  principal_id AS "principalId",
                  cnf_jkt AS "cnfJkt",
                  expires_at AS "expiresAt",
                  consumed_at AS "consumedAt",
                  revoked_at AS "revokedAt"
             FROM auth.workload_grants
            WHERE secret_hash = $1
            FOR UPDATE`,
          [grantHash],
        );
        const row = activeGrant(result.rows[0]);
        assertClaimsMatchGrant(claims, row);
        if (proof.jkt !== row.cnfJkt) {
          throw new WorkloadError("invalid_dpop_proof", 401);
        }
        await insertReplay(client, proof);

        if (row.mode === "create") {
          const inserted = await client.query(
            `INSERT INTO auth.workload_principals (principal_id, cnf_jkt, status)
             VALUES ($1, $2, 'active')
             ON CONFLICT DO NOTHING`,
            [row.principalId, row.cnfJkt],
          );
          if (inserted.rowCount !== 1) {
            throw new WorkloadError("conflict", 409);
          }
        } else {
          const rotated = await client.query(
            `UPDATE auth.workload_principals
                SET cnf_jkt = $1, updated_at = CURRENT_TIMESTAMP
              WHERE principal_id = $2 AND status = 'active'`,
            [row.cnfJkt, row.principalId],
          );
          if (rotated.rowCount !== 1) {
            throw new WorkloadError("conflict", 409);
          }
          await client.query(
            `UPDATE auth.workload_tokens
                SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'key_rotated'
              WHERE principal_id = $1 AND revoked_at IS NULL`,
            [row.principalId],
          );
        }

        await client.query(
          `UPDATE auth.workload_grants SET consumed_at = CURRENT_TIMESTAMP WHERE secret_hash = $1`,
          [grantHash],
        );
        await client.query(
          `INSERT INTO auth.workload_tokens
             (jti, principal_id, cnf_jkt, issued_at, expires_at)
           VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5))`,
          [claims.jti, claims.sub, claims.cnf.jkt, claims.iat, claims.exp],
        );
      });
    },

    async rotateToken(current, proof, next) {
      await transaction(database, async (client) => {
        if (next.sub !== current.sub || next.cnf.jkt !== current.cnf.jkt) {
          throw new WorkloadError("inactive_token", 401);
        }

        const active = await client.query(
          `SELECT 1
             FROM auth.workload_tokens AS token
             JOIN auth.workload_principals AS principal
               ON principal.principal_id = token.principal_id
            WHERE token.jti = $1
              AND token.principal_id = $2
              AND token.cnf_jkt = $3
              AND token.revoked_at IS NULL
              AND token.expires_at > CURRENT_TIMESTAMP
              AND principal.status = 'active'
              AND principal.revoked_at IS NULL
              AND principal.cnf_jkt = token.cnf_jkt
            FOR UPDATE OF token, principal`,
          [current.jti, current.sub, current.cnf.jkt],
        );
        if (active.rowCount !== 1 || proof.jkt !== current.cnf.jkt) {
          throw new WorkloadError("inactive_token", 401);
        }

        await insertReplay(client, proof);
        const revoked = await client.query(
          `UPDATE auth.workload_tokens
              SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'renewed'
            WHERE jti = $1 AND revoked_at IS NULL`,
          [current.jti],
        );
        if (revoked.rowCount !== 1) {
          throw new WorkloadError("inactive_token", 401);
        }
        await client.query(
          `INSERT INTO auth.workload_tokens
             (jti, principal_id, cnf_jkt, issued_at, expires_at)
           VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5))`,
          [next.jti, next.sub, next.cnf.jkt, next.iat, next.exp],
        );
      });
    },

    async isTokenActive(claims) {
      const result = await database.query(
        `SELECT 1
           FROM auth.workload_tokens AS token
           JOIN auth.workload_principals AS principal
             ON principal.principal_id = token.principal_id
          WHERE token.jti = $1
            AND token.principal_id = $2
            AND token.cnf_jkt = $3
            AND token.revoked_at IS NULL
            AND token.expires_at > CURRENT_TIMESTAMP
            AND principal.status = 'active'
            AND principal.revoked_at IS NULL
            AND principal.cnf_jkt = token.cnf_jkt
          LIMIT 1`,
        [claims.jti, claims.sub, claims.cnf.jkt],
      );
      return result.rowCount === 1;
    },

    async revoke(input) {
      return transaction(database, async (client) => {
        if (input.jti) {
          const result = await client.query(
            `UPDATE auth.workload_tokens
                SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                    revoked_reason = COALESCE(revoked_reason, 'operator_revoked')
              WHERE jti = $1`,
            [input.jti],
          );
          return result.rowCount ?? 0;
        }
        if (!input.principalId) {
          throw new WorkloadError("invalid_request", 400);
        }

        // Prevent a first exchange from activating a principal after revocation returns.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.principalId]);
        const principal = await client.query(
          `UPDATE auth.workload_principals
              SET status = 'revoked',
                  revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                  updated_at = CURRENT_TIMESTAMP
            WHERE principal_id = $1`,
          [input.principalId],
        );
        await client.query(
          `UPDATE auth.workload_tokens
              SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                  revoked_reason = COALESCE(revoked_reason, 'principal_revoked')
            WHERE principal_id = $1`,
          [input.principalId],
        );
        await client.query(
          `UPDATE auth.workload_grants
              SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
            WHERE principal_id = $1 AND consumed_at IS NULL`,
          [input.principalId],
        );
        return principal.rowCount ?? 0;
      });
    },
  };
}
