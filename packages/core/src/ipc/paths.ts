import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";

/**
 * Makes a Unix socket path safe to listen on (ADR 0006): a 0700 directory we own, not a symlink, and no live
 * listener. A stale socket file is removed. Windows needs nothing here: libuv creates the first pipe
 * instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so listening fails if anyone already holds the name.
 */
export async function prepareListenPath(path: string, platform = process.platform): Promise<void> {
  if (platform === "win32") return;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (process.getuid && st.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user`);
  }
  if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);

  let existing;
  try {
    existing = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!existing.isSocket()) throw new Error(`${path} exists and is not a socket`);
  if (await isListening(path)) {
    throw Object.assign(new Error(`another process is listening on ${path}`), {
      code: "EADDRINUSE",
    });
  }
  await unlink(path);
}

function isListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}
