export type WorkloadErrorCode =
  | "conflict"
  | "inactive_token"
  | "invalid_dpop_proof"
  | "invalid_grant"
  | "invalid_request"
  | "misconfigured"
  | "service_unavailable"
  | "unauthorized";

export class WorkloadError extends Error {
  readonly code: WorkloadErrorCode;
  readonly status: number;

  constructor(code: WorkloadErrorCode, status: number) {
    super(code);
    this.name = "WorkloadError";
    this.code = code;
    this.status = status;
  }
}
