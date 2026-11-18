import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Renderer hardening that does not need Electron to evaluate (ADR 0001). `main.ts` applies these rules
 * through Electron's session, protocol and web-contents hooks; the rules themselves are tested in plain Node.
 */

/** The renderer is served only from this privileged custom scheme, never from file:// or the network. */
export const APP_SCHEME = "citspark";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/** Sent as a response header on every app document and repeated in index.html. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The subset of Electron's WebFrameMain the check reads. */
export interface FrameLike {
  readonly url: string;
  readonly parent: unknown;
}

function isAppUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === `${APP_SCHEME}:` &&
    url.host === APP_HOST &&
    url.username === "" &&
    url.port === ""
  );
}

/** IPC is accepted only from the top-level frame of an app document; subframes and other origins are refused. */
export function isTrustedSender(frame: FrameLike | null | undefined): boolean {
  if (!frame || frame.parent) return false;
  return isAppUrl(frame.url);
}

/** Every request a renderer makes must stay inside the app scheme (DevTools front-end excepted in development). */
export function isAllowedRequestUrl(raw: string): boolean {
  if (raw.startsWith("devtools://")) return true;
  return isAppUrl(raw);
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/**
 * Maps an app URL to a regular file under `root`, or `undefined`. Refuses other hosts, encoded or literal
 * traversal, symlinks that leave the root, directories and unknown file types.
 */
export function resolveAppAsset(
  root: string,
  raw: string,
): { file: string; mimeType: string } | undefined {
  if (!isAppUrl(raw)) return undefined;
  const url = new URL(raw);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (path === "/") path = "/index.html";
  if (path.includes("\0") || path.split(/[\\/]/).includes("..")) return undefined;
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) return undefined;
  const candidate = join(root, path);
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(candidate);
    const rel = relative(realRoot, real);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
      return undefined;
    if (!statSync(real).isFile()) return undefined;
    return { file: real, mimeType };
  } catch {
    return undefined;
  }
}
