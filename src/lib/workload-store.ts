import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { WorkloadError } from "./workload-errors.js";
import type { WorkloadTokenClaims } from "./workload-token.js";

export type WorkloadGrantMode = "enroll" | "rotate";

export interface WorkloadGrantInput {
  mode: WorkloadGrantMode;
  workerId: string;
  tenantId: string;
  agentId: string;
  enrollmentId: string;
  jkt: string;
}

export interface WorkloadGrant extends WorkloadGrantInput {
  grant: string;
  expiresAt: Date;
}

export interface WorkloadGrantRecord extends WorkloadGrantInput {
  expiresAt: Date;
}

export interface WorkloadProofReplay {
  jkt: string;
  proofJti: string;
  expiresAt: Date;
}

export interface WorkloadStore {
  createGrant(input: WorkloadGrantInput, ttlSeconds: number): Promise<WorkloadGrant>;
  readGrant(grant: string): Promise<WorkloadGrantRecord>;
  consumeGrantAndIssue(
    grant: string,
    proof: WorkloadProofReplay,
    claims: WorkloadTokenClaims,
  ): Promise<void>;
  rotateToken(
    current: WorkloadTokenClaims,
    proof: WorkloadProofReplay,
    next: WorkloadTokenClaims,
  ): Promise<void>;
  isTokenActive(claims: WorkloadTokenClaims): Promise<boolean>;
  revoke(input: { jti?: string; enrollmentId?: string }): Promise<number>;
}

interface GrantRow {
  mode: WorkloadGrantMode;
  workerId: string;
  tenantId: string;
  agentId: string;
  enrollmentId: string;
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
  if (
    claims.sub !== grant.workerId ||
    claims.tenant_id !== grant.tenantId ||
    claims.agent_id !== grant.agentId ||
    claims.enrollment_id !== grant.enrollmentId ||
    claims.cnf.jkt !== grant.cnfJkt
  ) {
    throw new WorkloadError("invalid_grant", 400);
  }
}

export function createPostgresWorkloadStore(database: Pick<Pool, "connect" | "query">): WorkloadStore {
  return {
    async createGrant(input, ttlSeconds) {
      return transaction(database, async (client) => {
        // An enrollment row does not exist during first enrollment, so serialize on its stable identifier.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.enrollmentId]);
        const identity = await client.query<{
          status: string;
          workerId: string;
          tenantId: string;
          agentId: string;
        }>(
          `SELECT status,
                  worker_id AS "workerId",
                  tenant_id AS "tenantId",
                  agent_id AS "agentId"
             FROM auth.workload_identities
            WHERE enrollment_id = $1
            FOR UPDATE`,
          [input.enrollmentId],
        );

        if (
          (input.mode === "enroll" && identity.rowCount !== 0) ||
          (input.mode === "rotate" && (
            identity.rowCount !== 1 ||
            identity.rows[0]?.status !== "active" ||
            identity.rows[0]?.workerId !== input.workerId ||
            identity.rows[0]?.tenantId !== input.tenantId ||
            identity.rows[0]?.agentId !== input.agentId
          ))
        ) {
          throw new WorkloadError("conflict", 409);
        }

        await client.query(
          `UPDATE auth.workload_enrollment_grants
              SET revoked_at = CURRENT_TIMESTAMP
            WHERE enrollment_id = $1
              AND consumed_at IS NULL
              AND revoked_at IS NULL`,
          [input.enrollmentId],
        );

        const grant = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        await client.query(
          `INSERT INTO auth.workload_enrollment_grants
             (id, secret_hash, mode, worker_id, tenant_id, agent_id, enrollment_id, cnf_jkt, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            randomUUID(),
            secretHash(grant),
            input.mode,
            input.workerId,
            input.tenantId,
            input.agentId,
            input.enrollmentId,
            input.jkt,
            expiresAt,
          ],
        );
        return { ...input, grant, expiresAt };
      });
    },

    async readGrant(grant) {
      const result = await database.query<GrantRow>(
        `SELECT mode,
                worker_id AS "workerId",
                tenant_id AS "tenantId",
                agent_id AS "agentId",
                enrollment_id AS "enrollmentId",
                cnf_jkt AS "cnfJkt",
                expires_at AS "expiresAt",
                consumed_at AS "consumedAt",
                revoked_at AS "revokedAt"
           FROM auth.workload_enrollment_grants
          WHERE secret_hash = $1
          LIMIT 1`,
        [secretHash(grant)],
      );
      const row = activeGrant(result.rows[0]);
      return {
        mode: row.mode,
        workerId: row.workerId,
        tenantId: row.tenantId,
        agentId: row.agentId,
        enrollmentId: row.enrollmentId,
        jkt: row.cnfJkt,
        expiresAt: row.expiresAt,
      };
    },

    async consumeGrantAndIssue(grant, proof, claims) {
      await transaction(database, async (client) => {
        const result = await client.query<GrantRow>(
          `SELECT mode,
                  worker_id AS "workerId",
                  tenant_id AS "tenantId",
                  agent_id AS "agentId",
                  enrollment_id AS "enrollmentId",
                  cnf_jkt AS "cnfJkt",
                  expires_at AS "expiresAt",
                  consumed_at AS "consumedAt",
                  revoked_at AS "revokedAt"
             FROM auth.workload_enrollment_grants
            WHERE secret_hash = $1
            FOR UPDATE`,
          [secretHash(grant)],
        );
        const row = activeGrant(result.rows[0]);
        assertClaimsMatchGrant(claims, row);
        if (proof.jkt !== row.cnfJkt) {
          throw new WorkloadError("invalid_dpop_proof", 401);
        }
        await insertReplay(client, proof);

        if (row.mode === "enroll") {
          const inserted = await client.query(
            `INSERT INTO auth.workload_identities
               (enrollment_id, worker_id, tenant_id, agent_id, cnf_jkt, status)
             VALUES ($1, $2, $3, $4, $5, 'active')
             ON CONFLICT DO NOTHING`,
            [row.enrollmentId, row.workerId, row.tenantId, row.agentId, row.cnfJkt],
          );
          if (inserted.rowCount !== 1) {
            throw new WorkloadError("conflict", 409);
          }
        } else {
          const rotated = await client.query(
            `UPDATE auth.workload_identities
                SET cnf_jkt = $1, updated_at = CURRENT_TIMESTAMP
              WHERE enrollment_id = $2
                AND worker_id = $3
                AND tenant_id = $4
                AND agent_id = $5
                AND status = 'active'`,
            [row.cnfJkt, row.enrollmentId, row.workerId, row.tenantId, row.agentId],
          );
          if (rotated.rowCount !== 1) {
            throw new WorkloadError("conflict", 409);
          }
          await client.query(
            `UPDATE auth.workload_tokens
                SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'key_rotated'
              WHERE enrollment_id = $1 AND revoked_at IS NULL`,
            [row.enrollmentId],
          );
        }

        await client.query(
          `UPDATE auth.workload_enrollment_grants
              SET consumed_at = CURRENT_TIMESTAMP
            WHERE secret_hash = $1`,
          [secretHash(grant)],
        );
        await client.query(
          `INSERT INTO auth.workload_tokens
             (jti, enrollment_id, worker_id, tenant_id, agent_id, cnf_jkt, issued_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8))`,
          [
            claims.jti,
            claims.enrollment_id,
            claims.sub,
            claims.tenant_id,
            claims.agent_id,
            claims.cnf.jkt,
            claims.iat,
            claims.exp,
          ],
        );
      });
    },

    async rotateToken(current, proof, next) {
      await transaction(database, async (client) => {
        if (
          next.sub !== current.sub ||
          next.tenant_id !== current.tenant_id ||
          next.agent_id !== current.agent_id ||
          next.enrollment_id !== current.enrollment_id ||
          next.cnf.jkt !== current.cnf.jkt
        ) {
          throw new WorkloadError("inactive_token", 401);
        }

        const active = await client.query(
          `SELECT 1
             FROM auth.workload_tokens AS token
             JOIN auth.workload_identities AS identity
               ON identity.enrollment_id = token.enrollment_id
            WHERE token.jti = $1
              AND token.enrollment_id = $2
              AND token.worker_id = $3
              AND token.tenant_id = $4
              AND token.agent_id = $5
              AND token.cnf_jkt = $6
              AND token.revoked_at IS NULL
              AND token.expires_at > CURRENT_TIMESTAMP
              AND identity.status = 'active'
              AND identity.revoked_at IS NULL
              AND identity.cnf_jkt = token.cnf_jkt
            FOR UPDATE OF token, identity`,
          [current.jti, current.enrollment_id, current.sub, current.tenant_id, current.agent_id, current.cnf.jkt],
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
             (jti, enrollment_id, worker_id, tenant_id, agent_id, cnf_jkt, issued_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8))`,
          [next.jti, next.enrollment_id, next.sub, next.tenant_id, next.agent_id, next.cnf.jkt, next.iat, next.exp],
        );
      });
    },

    async isTokenActive(claims) {
      const result = await database.query(
        `SELECT 1
           FROM auth.workload_tokens AS token
           JOIN auth.workload_identities AS identity
             ON identity.enrollment_id = token.enrollment_id
          WHERE token.jti = $1
            AND token.enrollment_id = $2
            AND token.worker_id = $3
            AND token.tenant_id = $4
            AND token.agent_id = $5
            AND token.cnf_jkt = $6
            AND token.revoked_at IS NULL
            AND token.expires_at > CURRENT_TIMESTAMP
            AND identity.status = 'active'
            AND identity.revoked_at IS NULL
            AND identity.cnf_jkt = token.cnf_jkt
          LIMIT 1`,
        [claims.jti, claims.enrollment_id, claims.sub, claims.tenant_id, claims.agent_id, claims.cnf.jkt],
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
        if (!input.enrollmentId) {
          throw new WorkloadError("invalid_request", 400);
        }

        const identity = await client.query(
          `UPDATE auth.workload_identities
              SET status = 'revoked',
                  revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                  updated_at = CURRENT_TIMESTAMP
            WHERE enrollment_id = $1`,
          [input.enrollmentId],
        );
        await client.query(
          `UPDATE auth.workload_tokens
              SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                  revoked_reason = COALESCE(revoked_reason, 'enrollment_revoked')
            WHERE enrollment_id = $1`,
          [input.enrollmentId],
        );
        await client.query(
          `UPDATE auth.workload_enrollment_grants
              SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
            WHERE enrollment_id = $1 AND consumed_at IS NULL`,
          [input.enrollmentId],
        );
        return identity.rowCount ?? 0;
      });
    },
  };
}
