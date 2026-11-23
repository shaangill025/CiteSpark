import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { RawFrameReader, writeRawFrame } from "./frames.ts";

/** Chrome limits messages from a native host to the extension to 1 MiB. */
export const TO_EXTENSION_MAX_BYTES = 1024 * 1024;
/** The core rejects socket frames above this (SOCKET_MAX_FRAME_BYTES in @citspark/ipc/node). */
export const TO_CORE_MAX_BYTES = 128 * 1024;

const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;

export interface HostConfig {
  /** Exact `chrome-extension://<id>/` origins, the same list as the host manifest's allowed_origins. */
  allowedOrigins: string[];
  socketPath: string;
}

export function parseHostConfig(value: unknown): HostConfig {
  const v = value as Partial<HostConfig> | null;
  if (
    !v ||
    typeof v.socketPath !== "string" ||
    v.socketPath.length === 0 ||
    !Array.isArray(v.allowedOrigins) ||
    !v.allowedOrigins.every((o) => typeof o === "string" && ORIGIN.test(o))
  ) {
    throw new Error("invalid native host config");
  }
  return { allowedOrigins: [...v.allowedOrigins], socketPath: v.socketPath };
}

/** The installer's launcher sets CITSPARK_HOST_CONFIG; otherwise the config sits beside the host. */
export function resolveConfigPath(env: NodeJS.ProcessEnv, hostDir: string): string {
  const p = env["CITSPARK_HOST_CONFIG"];
  return p && isAbsolute(p) ? p : join(hostDir, "native-host.json");
}

export async function loadHostConfig(path: string): Promise<HostConfig> {
  return parseHostConfig(JSON.parse(await readFile(path, "utf8")));
}

/**
 * Chrome starts the host with the caller origin as the first argument (Windows adds --parent-window=N).
 * Returns the origin only if it is on the allowlist.
 */
export function checkOrigin(args: readonly string[], config: HostConfig): string | undefined {
  const origin = args[0];
  if (origin === undefined || !ORIGIN.test(origin)) return undefined;
  return config.allowedOrigins.includes(origin) ? origin : undefined;
}

/**
 * Native messaging host (ADR 0006, ADR 0011): checks the caller origin, then relays frames between Chrome
 * and the core socket. It never parses, stores or logs a frame body; it carries hello, Noise handshake
 * messages and ciphertext records only. Resolves with the process exit code.
 */
export async function runHost(opts: {
  args: readonly string[];
  config: HostConfig;
  stdin: Readable;
  stdout: Writable;
  connect: (path: string) => Promise<Duplex>;
  littleEndian?: boolean;
}): Promise<number> {
  if (!checkOrigin(opts.args, opts.config)) return 2;
  const le = opts.littleEndian ?? true;
  let socket: Duplex;
  try {
    socket = await opts.connect(opts.config.socketPath);
  } catch {
    return 3;
  }
  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      socket.destroy();
      opts.stdin.off("data", fromChrome);
      opts.stdin.pause();
      resolve(code);
    };
    const toCore = new RawFrameReader({ maxFrameBytes: TO_CORE_MAX_BYTES, littleEndian: le });
    const toChrome = new RawFrameReader({
      maxFrameBytes: TO_EXTENSION_MAX_BYTES,
      littleEndian: false,
    });
    const fromChrome = (chunk: Buffer) => {
      try {
        for (const body of toCore.push(chunk)) socket.write(writeRawFrame(body, false));
      } catch {
        finish(4);
      }
    };
    opts.stdin.on("data", fromChrome);
    opts.stdin.once("end", () => finish(0));
    opts.stdin.once("error", () => finish(5));
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const body of toChrome.push(chunk)) opts.stdout.write(writeRawFrame(body, le));
      } catch {
        finish(4);
      }
    });
    socket.once("close", () => finish(0));
    socket.once("error", () => finish(3));
  });
}
