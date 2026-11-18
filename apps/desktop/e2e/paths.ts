import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = fileURLToPath(new URL("../build/app", import.meta.url));
export const PRELOAD = join(APP_DIR, "dist", "preload.cjs");
/** Screenshots and measurements. Defaults under the OS temp directory (TMPDIR), never inside the repository. */
export const ARTIFACT_DIR =
  process.env.CITSPARK_ARTIFACT_DIR ?? join(tmpdir(), "citspark-desktop-artifacts");

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
