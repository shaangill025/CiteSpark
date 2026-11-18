import { z } from "zod";

export const ErrorCode = {
  Incompatible: "incompatible",
  FrameTooLarge: "frame_too_large",
  MalformedFrame: "malformed_frame",
  InvalidMessage: "invalid_message",
  IdempotencyConflict: "idempotency_conflict",
  IdempotencyExhausted: "idempotency_exhausted",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  PairingFailed: "pairing_failed",
  PairingLocked: "pairing_locked",
  PairingExpired: "pairing_expired",
  Internal: "internal",
  // Capture (M1-08). None of these lets a job end as complete.
  DiskFull: "disk_full",
  AccountMismatch: "account_mismatch",
  CursorLoop: "cursor_loop",
  CursorMismatch: "cursor_mismatch",
  JobBusy: "job_busy",
  LeaseLost: "lease_lost",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ProtocolErrorSchema = z.strictObject({
  code: z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]),
  message: z.string().max(1024),
  details: z.record(z.string(), z.json()).optional(),
});
export type ProtocolErrorBody = z.infer<typeof ProtocolErrorSchema>;

export function protocolError(
  code: ErrorCode,
  message: string,
  details?: Record<string, z.core.util.JSONType>,
): ProtocolErrorBody {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Thrown by framing and session helpers; carries the structured body to send to the peer. */
export class ProtocolException extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ProtocolException";
    this.code = code;
  }
  toBody(): ProtocolErrorBody {
    return protocolError(this.code, this.message);
  }
}
