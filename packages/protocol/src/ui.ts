import { z } from "zod";
import { ProtocolErrorSchema } from "./errors.ts";
import { VersionRangeSchema } from "./messages.ts";

/**
 * The desktop renderer's channel to the core (ADR 0001, ADR 0006). The renderer reaches the core only through
 * the Electron main process, which relays these messages over a MessagePort to the core's utility process.
 * The renderer holds no privileged state, so this channel has no Noise handshake; it negotiates the same
 * protocol versions and sends the same request and response shapes as paired clients.
 */
export const UiHelloSchema = z.strictObject({
  type: z.literal("ui.hello"),
  versions: VersionRangeSchema,
});
export type UiHello = z.infer<typeof UiHelloSchema>;

export const UiHelloReplySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ui.hello.ok"),
    version: z.int().min(1).max(65535),
    core: z.strictObject({ version: z.string().min(1).max(64) }),
  }),
  z.strictObject({ type: z.literal("ui.hello.error"), error: ProtocolErrorSchema }),
]);
export type UiHelloReply = z.infer<typeof UiHelloReplySchema>;

/** Bounds every message on the renderer channel, in both directions. */
export const UI_PROTOCOL_LIMITS = Object.freeze({
  /** Serialized UTF-8 size of one message. */
  maxMessageBytes: 64 * 1024,
  /** Requests one renderer may have outstanding at once. */
  maxInFlight: 16,
  /** A request the core has not answered by then fails with `internal`. */
  requestTimeoutMs: 10_000,
});

/** Serialized size of `value` in UTF-8 bytes, or `undefined` if it cannot be serialized as JSON. */
export function jsonByteLength(value: unknown): number | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : Buffer.byteLength(text, "utf8");
  } catch {
    return undefined;
  }
}
