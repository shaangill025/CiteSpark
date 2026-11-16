import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "@citspark/protocol";
import { MessageQueue, type MessageTransport, TransportClosedError } from "./transport.ts";

/** Socket frames carry hello, handshake and record frames only; all are far below this. */
export const SOCKET_MAX_FRAME_BYTES = 128 * 1024;

/**
 * Per-user endpoint (ADR 0006). Unix: a socket inside a 0700 directory. Windows: a named pipe; pipe names are
 * machine-global, so the name is per-user, and a squatter is defeated by the pinned desktop key, not the name.
 */
export function defaultIpcPath(
  opts: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    username?: string;
  } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  if (platform === "win32") {
    const user = opts.username ?? userInfo().username;
    const tag = createHash("sha256").update(`${user}\0${home}`).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\citspark-core-${tag}`;
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Citspark", "ipc", "core.sock");
  }
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime && runtime.startsWith("/")
    ? join(runtime, "citspark", "core.sock")
    : join(home, ".local", "state", "citspark", "ipc", "core.sock");
}

export function socketTransport(
  socket: Socket,
  opts: { maxFrameBytes?: number } = {},
): MessageTransport {
  const queue = new MessageQueue();
  const maxFrameBytes = opts.maxFrameBytes ?? SOCKET_MAX_FRAME_BYTES;
  const decoder = new FrameDecoder({ maxFrameBytes });
  socket.on("data", (chunk: Buffer) => {
    try {
      for (const m of decoder.push(chunk)) queue.push(m);
    } catch (e) {
      queue.close(new TransportClosedError("bad frame", { cause: e }));
      socket.destroy();
    }
  });
  socket.on("close", () => queue.close());
  socket.on("error", (e) => queue.close(new TransportClosedError("socket error", { cause: e })));
  return {
    send(message) {
      if (!socket.destroyed) socket.write(encodeFrame(message, maxFrameBytes));
    },
    receive: () => queue.next(),
    close() {
      queue.close();
      if (socket.destroyed) return;
      // end() flushes a final error frame; the timer stops a peer that never closes its side.
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
    },
  };
}

export function connectIpc(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}
