import { z } from "zod";
import { ErrorCode, ProtocolErrorSchema, protocolError, type ProtocolErrorBody } from "./errors.ts";

export const SUPPORTED_VERSIONS = { min: 1, max: 1 } as const;

const Version = z.int().min(1).max(65535);
export const VersionRangeSchema = z
  .strictObject({ min: Version, max: Version })
  .refine((r) => r.min <= r.max, "min must be <= max");
export type VersionRange = z.infer<typeof VersionRangeSchema>;

export const ClientKindSchema = z.enum(["extension", "obsidian-plugin", "desktop-ui"]);

export const HelloSchema = z.strictObject({
  type: z.literal("hello"),
  versions: VersionRangeSchema,
  client: z.strictObject({ kind: ClientKindSchema, version: z.string().min(1).max(64) }),
  /** `pair` runs Noise XX plus the 6-digit code; `session` runs Noise IK with paired keys (ADR 0011). */
  channel: z.enum(["pair", "session"]),
});
export type Hello = z.infer<typeof HelloSchema>;

export const HelloOkSchema = z.strictObject({
  type: z.literal("hello.ok"),
  version: Version,
  core: z.strictObject({ version: z.string().min(1).max(64) }),
});
export const HelloErrorSchema = z.strictObject({
  type: z.literal("hello.error"),
  error: ProtocolErrorSchema,
});
export const HelloReplySchema = z.discriminatedUnion("type", [HelloOkSchema, HelloErrorSchema]);
export type HelloReply = z.infer<typeof HelloReplySchema>;

export const RequestIdSchema = z.string().min(1).max(128);

export const RequestSchema = z.strictObject({
  v: Version,
  id: RequestIdSchema,
  method: z.string().min(1).max(128),
  mutation: z.boolean(),
  payload: z.json(),
});
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ v: Version, id: RequestIdSchema, ok: z.literal(true), result: z.json() }),
  z.strictObject({
    v: Version,
    id: RequestIdSchema,
    ok: z.literal(false),
    error: ProtocolErrorSchema,
  }),
]);

export const StreamStateSchema = z.enum(["open", "complete", "cancelled", "failed"]);
export type StreamState = z.infer<typeof StreamStateSchema>;

export const StreamEventSchema = z.strictObject({
  streamId: z.string().min(1).max(128),
  seq: z.int().min(0),
  state: StreamStateSchema,
  data: z.json().optional(),
  error: ProtocolErrorSchema.optional(),
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const parseHello = (v: unknown) => HelloSchema.safeParse(v);
export const parseRequest = (v: unknown) => RequestSchema.safeParse(v);

export type NegotiationResult =
  { ok: true; version: number } | { ok: false; error: ProtocolErrorBody };

export function negotiateVersion(
  client: VersionRange,
  server: VersionRange = SUPPORTED_VERSIONS,
): NegotiationResult {
  const version = Math.min(client.max, server.max);
  if (version >= Math.max(client.min, server.min)) return { ok: true, version };
  return {
    ok: false,
    error: protocolError(
      ErrorCode.Incompatible,
      "This client and Citspark cannot talk to each other. Update the older one (client supports " +
        `v${client.min}-v${client.max}, Citspark supports v${server.min}-v${server.max}).`,
      {
        clientMin: client.min,
        clientMax: client.max,
        serverMin: server.min,
        serverMax: server.max,
      },
    ),
  };
}
