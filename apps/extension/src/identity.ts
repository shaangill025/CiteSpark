import { createHash } from "node:crypto";

/**
 * Public key (SPKI, base64) that pins the unpacked extension's ID, so the native messaging host can
 * list the exact origin (ADR 0006: no wildcards). Only the public half exists; an unpacked install
 * needs no private key. A store listing would add its own ID to the host allowlist.
 */
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkb4rHCpYJ/7BzQ4mfnM2KdOngEItE1tiRSnZUx2L++gQZcFNW5K3eAA7AbuLoJyWTatC/0TFDSqw2UUIkLBiTx9FQ0q3Z6/cHojMH39bFtrw0lFykFbz+pe/bLV/AX+/34fmT5ZMhwCBS1asNSjcqvGbNVEin3Lnd/rVIkahbWBYaHVH33fq3is9K/a/9FmqpZ+3DunMo13lepcwe9oVY9YRIp6JZKL/aXvlhCq3gjeqhHRfsa7pqJ2MSJb5yPwxIoJTtyTp6QqJ27zeIeYdowO4MLGEOKOO0O/fvmVg+9PGN6XOJKiEvZcSXkBxJV4ZknOPUqNsj/lxCDvHXvVBmwIDAQAB"; // guardrails-disable-line: public SPKI key (no secret half); entropy false positive

export const EXTENSION_ID = "ifknmknhnlkmajhekjlicgcnmgbholce";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export { NATIVE_HOST_NAME } from "./shared/constants.ts";

/** Chromium's extension ID: the first 128 bits of SHA-256(SPKI DER), hex digits mapped to a-p. */
export function extensionIdFromKey(spkiBase64: string): string {
  const hex = createHash("sha256").update(Buffer.from(spkiBase64, "base64")).digest("hex");
  return [...hex.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
