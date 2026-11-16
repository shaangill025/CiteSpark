import { z } from "zod";
import { ProtocolErrorSchema } from "./errors.ts";
import type { Hello, HelloReply } from "./messages.ts";

/** Noise caps every handshake and transport message at 65535 bytes (Noise spec §3). */
export const MAX_NOISE_MESSAGE_BYTES = 65535;

export const Scope = {
  CaptureWrite: "capture.write",
  ImportWrite: "import.write",
  SyncRead: "sync.read",
  SyncResolve: "sync.resolve",
  SearchRead: "search.read",
  AnswerRun: "answer.run",
  ResearchRun: "research.run",
  /** Desktop UI only; never granted to a paired client (ADR 0006). */
  ClientsManage: "clients.manage",
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];

export const ScopeSchema = z.enum(Object.values(Scope) as [Scope, ...Scope[]]);
export const CLIENT_GRANTABLE_SCOPES: readonly Scope[] = Object.values(Scope).filter(
  (s) => s !== Scope.ClientsManage,
);
const GrantableScopeSchema = z.enum(CLIENT_GRANTABLE_SCOPES as [Scope, ...Scope[]]);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict padded base64 encoding of 1..maxBytes bytes. */
export function base64Of(maxBytes: number, exactBytes?: number) {
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  return z
    .string()
    .min(4)
    .max(maxChars)
    .regex(BASE64, "invalid base64")
    .refine((s) => {
      const bytes = (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
      return bytes <= maxBytes && (exactBytes === undefined || bytes === exactBytes);
    }, "wrong decoded length");
}

const Noise = base64Of(MAX_NOISE_MESSAGE_BYTES);
const Bytes32 = base64Of(32, 32);

/** A Noise handshake message. Sent in the clear; its contents are protected by Noise itself. */
export const HandshakeFrameSchema = z.strictObject({ type: z.literal("hs"), d: Noise });
/** One encrypted transport record. Nothing after the handshake travels outside a record. */
export const RecordFrameSchema = z.strictObject({ type: z.literal("rec"), d: Noise });
export type HandshakeFrame = z.infer<typeof HandshakeFrameSchema>;
export type RecordFrame = z.infer<typeof RecordFrameSchema>;

// Messages carried inside the encrypted pairing channel (Noise XX), in protocol order. The 6-digit code
// itself never travels: the client shows it and the user types it into the desktop (ADR 0011).
export const PairRequestSchema = z.strictObject({
  type: z.literal("pair.request"),
  scopes: z
    .array(GrantableScopeSchema)
    .min(1)
    .max(CLIENT_GRANTABLE_SCOPES.length)
    .refine((a) => new Set(a).size === a.length, "duplicate scope"),
});
export const PairCommitSchema = z.strictObject({ type: z.literal("pair.commit"), commit: Bytes32 });
export const PairNonceSchema = z.strictObject({ type: z.literal("pair.nonce"), nonce: Bytes32 });
export const PairRevealSchema = z.strictObject({ type: z.literal("pair.reveal"), nonce: Bytes32 });
export const PairAbortSchema = z.strictObject({ type: z.literal("pair.abort") });
export const PairOkSchema = z.strictObject({
  type: z.literal("pair.ok"),
  clientId: z.string().min(1).max(128),
  scopes: z.array(GrantableScopeSchema),
});
export const PairErrorSchema = z.strictObject({
  type: z.literal("pair.error"),
  error: ProtocolErrorSchema,
});

export const PairClientMessageSchema = z.discriminatedUnion("type", [
  PairRequestSchema,
  PairNonceSchema,
  PairAbortSchema,
]);
export const PairCoreMessageSchema = z.discriminatedUnion("type", [
  PairCommitSchema,
  PairRevealSchema,
  PairOkSchema,
  PairErrorSchema,
]);
export type PairClientMessage = z.infer<typeof PairClientMessageSchema>;
export type PairCoreMessage = z.infer<typeof PairCoreMessageSchema>;

/** JSON with object keys sorted at every level. Throws on values JSON cannot represent exactly. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`cannot canonicalise ${typeof value}`);
}

const PROLOGUE_LABEL = "citspark/hello/v1\n";

/**
 * The Noise prologue (ADR 0006, ADR 0011): the validated `hello` and its reply in canonical JSON. Both sides
 * compute it from the parsed messages, so a relay that re-serialises JSON (Chrome native messaging does)
 * keeps it stable, while any change to a field makes the handshake fail.
 */
export function helloPrologue(hello: Hello, reply: HelloReply): Uint8Array {
  return new TextEncoder().encode(PROLOGUE_LABEL + canonicalJson([hello, reply]));
}
