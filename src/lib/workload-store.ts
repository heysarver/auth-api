import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { WorkloadError } from "./workload-errors.js";
import type { WorkloadTokenClaims } from "./workload-token.js";

export type WorkloadGrantInput =
  | { mode: "create"; jkt: string; renewable?: boolean }
  | { mode: "rotate"; principalId: string; jkt: string; renewable?: boolean };

export interface WorkloadGrant {
  mode: "create" | "rotate";
  principalId: string;
  jkt: string;
  grant: string;
  renewable: boolean;
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
  consumeGrantAndIssue(grant: string, proof: WorkloadProofReplay, claims: WorkloadTokenClaims): Promise<WorkloadRenewalCredential | null>;
  rotateToken(current: WorkloadTokenClaims, proof: WorkloadProofReplay, next: WorkloadTokenClaims): Promise<void>;
  readRenewalCredential(credential: string): Promise<{ jkt: string; principalId: string }>;
  rotateRenewalCredential(
    credential: string,
    idempotencyKey: string,
    proof: WorkloadProofReplay,
    next: WorkloadTokenClaims,
  ): Promise<WorkloadRenewalRotation>;
  isTokenActive(claims: WorkloadTokenClaims): Promise<boolean>;
  credentialFamilyForToken(claims: WorkloadTokenClaims): Promise<string | null>;
  revoke(input: { familyId?: string; jti?: string; principalId?: string }): Promise<number>;
}

interface GrantRow {
  mode: "create" | "rotate";
  principalId: string;
  cnfJkt: string;
  renewable: boolean;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

export interface WorkloadRenewalCredential {
  credential: string;
  familyId: string;
  generation: number;
  expiresAt: Date;
}

export interface WorkloadRenewalRotation extends WorkloadRenewalCredential {
  claims: WorkloadTokenClaims;
}

interface RenewalRow {
  credentialId: string;
  familyId: string;
  principalId: string;
  cnfJkt: string;
  familyStatus: "active" | "revoked";
  familyExpiresAt: Date;
  credentialExpiresAt: Date;
  generation: number;
  consumedAt: Date | null;
  credentialRevokedAt: Date | null;
  familyRevokedAt: Date | null;
}

interface WorkloadStoreConfig {
  renewalSecret: string;
  renewalTtlSeconds: number;
  renewalIdempotencyTtlSeconds: number;
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function deriveRenewalCredential(secret: string, familyId: string, generation: number): string {
  const digest = createHmac("sha256", secret)
    .update(`workload-renewal/v1:${familyId}:${generation}`)
    .digest("base64url");
  return `wrc1_${digest}`;
}

function renewalClaims(row: {
  principalId: string;
  cnfJkt: string;
  accessTokenJti: string;
  accessTokenIssuedAt: string | number;
  accessTokenExpiresAt: string | number;
}, template: WorkloadTokenClaims): WorkloadTokenClaims {
  return {
    ...template,
    sub: row.principalId,
    jti: row.accessTokenJti,
    iat: Number(row.accessTokenIssuedAt),
    exp: Number(row.accessTokenExpiresAt),
    cnf: { jkt: row.cnfJkt },
  };
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

export function createPostgresWorkloadStore(
  database: Pick<Pool, "connect" | "query">,
  config: WorkloadStoreConfig = {
    renewalSecret: "test-only-renewal-secret-that-is-long-enough",
    renewalTtlSeconds: 31_536_000,
    renewalIdempotencyTtlSeconds: 120,
  },
): WorkloadStore {
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
             (id, secret_hash, mode, principal_id, cnf_jkt, expires_at, renewable)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), secretHash(grant), input.mode, principalId, input.jkt, expiresAt, input.renewable === true],
        );
        return { mode: input.mode, principalId, jkt: input.jkt, grant, renewable: input.renewable === true, expiresAt };
      });
    },

    async readGrant(grant) {
      const result = await database.query<GrantRow>(
        `SELECT mode,
                principal_id AS "principalId",
                cnf_jkt AS "cnfJkt",
                renewable,
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
        renewable: row.renewable,
        expiresAt: row.expiresAt,
      };
    },

    async consumeGrantAndIssue(grant, proof, claims) {
      return transaction(database, async (client) => {
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
                  renewable,
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
          await client.query(
            `UPDATE auth.workload_renewal_families
                SET status = 'revoked',
                    revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                    revoked_reason = COALESCE(revoked_reason, 'key_rotated'),
                    updated_at = CURRENT_TIMESTAMP
              WHERE principal_id = $1 AND status = 'active'`,
            [row.principalId],
          );
          await client.query(
            `UPDATE auth.workload_renewal_credentials AS credential
                SET revoked_at = COALESCE(credential.revoked_at, CURRENT_TIMESTAMP)
               FROM auth.workload_renewal_families AS family
              WHERE credential.family_id = family.id
                AND family.principal_id = $1`,
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

        if (!row.renewable) {
          return null;
        }
        const familyId = randomUUID();
        const credentialId = randomUUID();
        const generation = 0;
        const expiresAt = new Date(Date.now() + config.renewalTtlSeconds * 1000);
        const credential = deriveRenewalCredential(config.renewalSecret, familyId, generation);
        await client.query(
          `INSERT INTO auth.workload_renewal_families
             (id, principal_id, cnf_jkt, status, expires_at)
           VALUES ($1, $2, $3, 'active', $4)`,
          [familyId, claims.sub, claims.cnf.jkt, expiresAt],
        );
        await client.query(
          `INSERT INTO auth.workload_renewal_credentials
             (id, family_id, secret_hash, generation, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [credentialId, familyId, secretHash(credential), generation, expiresAt],
        );
        await client.query(
          `UPDATE auth.workload_tokens SET renewal_family_id = $2 WHERE jti = $1`,
          [claims.jti, familyId],
        );
        return { credential, familyId, generation, expiresAt };
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
              AND token.renewal_family_id IS NULL
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

    async readRenewalCredential(credential) {
      const result = await database.query<RenewalRow>(
        `SELECT credential.id AS "credentialId",
                credential.family_id AS "familyId",
                family.principal_id AS "principalId",
                family.cnf_jkt AS "cnfJkt",
                family.status AS "familyStatus",
                family.expires_at AS "familyExpiresAt",
                credential.expires_at AS "credentialExpiresAt",
                credential.generation,
                credential.consumed_at AS "consumedAt",
                credential.revoked_at AS "credentialRevokedAt",
                family.revoked_at AS "familyRevokedAt"
           FROM auth.workload_renewal_credentials AS credential
           JOIN auth.workload_renewal_families AS family ON family.id = credential.family_id
          WHERE credential.secret_hash = $1
          LIMIT 1`,
        [secretHash(credential)],
      );
      const row = result.rows[0];
      const now = new Date();
      if (
        !row ||
        row.familyStatus !== "active" ||
        row.familyRevokedAt ||
        row.credentialRevokedAt ||
        row.familyExpiresAt <= now ||
        row.credentialExpiresAt <= now
      ) {
        throw new WorkloadError("invalid_renewal_credential", 401);
      }
      return { jkt: row.cnfJkt, principalId: row.principalId };
    },

    async rotateRenewalCredential(credential, idempotencyKey, proof, next) {
      const outcome = await transaction<WorkloadRenewalRotation | null>(database, async (client) => {
        const credentialHash = secretHash(credential);
        const binding = await client.query<{ familyId: string }>(
          `SELECT family_id AS "familyId"
             FROM auth.workload_renewal_credentials
            WHERE secret_hash = $1
            LIMIT 1`,
          [credentialHash],
        );
        const familyId = binding.rows[0]?.familyId;
        if (!familyId) {
          return null;
        }
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [familyId]);
        const result = await client.query<RenewalRow>(
          `SELECT credential.id AS "credentialId",
                  credential.family_id AS "familyId",
                  family.principal_id AS "principalId",
                  family.cnf_jkt AS "cnfJkt",
                  family.status AS "familyStatus",
                  family.expires_at AS "familyExpiresAt",
                  credential.expires_at AS "credentialExpiresAt",
                  credential.generation,
                  credential.consumed_at AS "consumedAt",
                  credential.revoked_at AS "credentialRevokedAt",
                  family.revoked_at AS "familyRevokedAt"
             FROM auth.workload_renewal_credentials AS credential
             JOIN auth.workload_renewal_families AS family ON family.id = credential.family_id
            WHERE credential.secret_hash = $1
            FOR UPDATE OF credential, family`,
          [credentialHash],
        );
        const row = result.rows[0];
        const now = new Date();
        if (
          !row ||
          row.familyStatus !== "active" ||
          row.familyRevokedAt ||
          row.credentialRevokedAt ||
          row.familyExpiresAt <= now ||
          row.credentialExpiresAt <= now ||
          row.cnfJkt !== proof.jkt
        ) {
          throw new WorkloadError("invalid_renewal_credential", 401);
        }

        await insertReplay(client, proof);
        const idempotencyKeyHash = secretHash(idempotencyKey);
        if (row.consumedAt) {
          const replay = await client.query<{
            replacementCredentialId: string;
            replacementGeneration: number;
            replacementExpiresAt: Date;
            accessTokenJti: string;
            accessTokenIssuedAt: string;
            accessTokenExpiresAt: string;
          }>(
            `SELECT replacement.id AS "replacementCredentialId",
                    replacement.generation AS "replacementGeneration",
                    replacement.expires_at AS "replacementExpiresAt",
                    replay.access_token_jti AS "accessTokenJti",
                    replay.access_token_issued_at AS "accessTokenIssuedAt",
                    replay.access_token_expires_at AS "accessTokenExpiresAt"
               FROM auth.workload_renewal_idempotency AS replay
               JOIN auth.workload_renewal_credentials AS replacement
                 ON replacement.id = replay.replacement_credential_id
              WHERE replay.family_id = $1
                AND replay.request_key_hash = $2
                AND replay.credential_id = $3
                AND replay.expires_at > CURRENT_TIMESTAMP`,
            [row.familyId, idempotencyKeyHash, row.credentialId],
          );
          const saved = replay.rows[0];
          if (saved) {
            const replacement = deriveRenewalCredential(
              config.renewalSecret,
              row.familyId,
              saved.replacementGeneration,
            );
            return {
              credential: replacement,
              familyId: row.familyId,
              generation: saved.replacementGeneration,
              expiresAt: saved.replacementExpiresAt,
              claims: renewalClaims({ ...saved, principalId: row.principalId, cnfJkt: row.cnfJkt }, next),
            };
          }

          // A consumed credential used with a different or expired request key is theft/reuse.
          await client.query(
            `UPDATE auth.workload_renewal_families
                SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP,
                    revoked_reason = 'credential_reuse', updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [row.familyId],
          );
          await client.query(
            `UPDATE auth.workload_renewal_credentials
                SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
              WHERE family_id = $1`,
            [row.familyId],
          );
          await client.query(
            `UPDATE auth.workload_tokens
                SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                    revoked_reason = COALESCE(revoked_reason, 'credential_reuse')
              WHERE renewal_family_id = $1`,
            [row.familyId],
          );
          return null;
        }

        if (next.sub !== row.principalId || next.cnf.jkt !== row.cnfJkt) {
          throw new WorkloadError("invalid_renewal_credential", 401);
        }
        const nextGeneration = row.generation + 1;
        const nextCredentialId = randomUUID();
        const nextCredential = deriveRenewalCredential(config.renewalSecret, row.familyId, nextGeneration);
        const nextExpiresAt = new Date(Date.now() + config.renewalTtlSeconds * 1000);
        await client.query(
          `UPDATE auth.workload_renewal_credentials
              SET consumed_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND consumed_at IS NULL`,
          [row.credentialId],
        );
        await client.query(
          `INSERT INTO auth.workload_renewal_credentials
             (id, family_id, secret_hash, generation, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [nextCredentialId, row.familyId, secretHash(nextCredential), nextGeneration, nextExpiresAt],
        );
        await client.query(
          `UPDATE auth.workload_renewal_families
              SET expires_at = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [row.familyId, nextExpiresAt],
        );
        await client.query(
          `UPDATE auth.workload_tokens
              SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                  revoked_reason = COALESCE(revoked_reason, 'renewed')
            WHERE principal_id = $1 AND revoked_at IS NULL`,
          [row.principalId],
        );
        await client.query(
          `INSERT INTO auth.workload_tokens
             (jti, principal_id, cnf_jkt, issued_at, expires_at, renewal_family_id)
           VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5), $6)`,
          [next.jti, next.sub, next.cnf.jkt, next.iat, next.exp, row.familyId],
        );
        await client.query(
          `INSERT INTO auth.workload_renewal_idempotency
             (family_id, request_key_hash, credential_id, replacement_credential_id,
              access_token_jti, access_token_issued_at, access_token_expires_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   CURRENT_TIMESTAMP + make_interval(secs => $8))`,
          [
            row.familyId,
            idempotencyKeyHash,
            row.credentialId,
            nextCredentialId,
            next.jti,
            next.iat,
            next.exp,
            config.renewalIdempotencyTtlSeconds,
          ],
        );
        return {
          credential: nextCredential,
          familyId: row.familyId,
          generation: nextGeneration,
          expiresAt: nextExpiresAt,
          claims: next,
        };
      });
      if (!outcome) {
        throw new WorkloadError("invalid_renewal_credential", 401);
      }
      return outcome;
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

    async credentialFamilyForToken(claims) {
      const result = await database.query<{ familyId: string | null }>(
        `SELECT token.renewal_family_id AS "familyId"
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
      return result.rows[0]?.familyId ?? null;
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
        if (input.familyId) {
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.familyId]);
          const family = await client.query<{ principalId: string }>(
            `UPDATE auth.workload_renewal_families
                SET status = 'revoked',
                    revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                    revoked_reason = COALESCE(revoked_reason, 'operator_revoked'),
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $1
              RETURNING principal_id AS "principalId"`,
            [input.familyId],
          );
          await client.query(
            `UPDATE auth.workload_renewal_credentials
                SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
              WHERE family_id = $1`,
            [input.familyId],
          );
          const principalId = family.rows[0]?.principalId;
          if (principalId) {
            await client.query(
              `UPDATE auth.workload_tokens
                  SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                      revoked_reason = COALESCE(revoked_reason, 'family_revoked')
                WHERE renewal_family_id = $1`,
              [input.familyId],
            );
          }
          return family.rowCount ?? 0;
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
        await client.query(
          `UPDATE auth.workload_renewal_families
              SET status = 'revoked',
                  revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                  revoked_reason = COALESCE(revoked_reason, 'principal_revoked'),
                  updated_at = CURRENT_TIMESTAMP
            WHERE principal_id = $1`,
          [input.principalId],
        );
        await client.query(
          `UPDATE auth.workload_renewal_credentials AS credential
              SET revoked_at = COALESCE(credential.revoked_at, CURRENT_TIMESTAMP)
             FROM auth.workload_renewal_families AS family
            WHERE credential.family_id = family.id
              AND family.principal_id = $1`,
          [input.principalId],
        );
        return principal.rowCount ?? 0;
      });
    },
  };
}
