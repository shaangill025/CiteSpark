import { EXTENSION_PUBLIC_KEY } from "./identity.ts";

/**
 * The MV3 manifest (ADR 0005, M1-08). Least privilege: `nativeMessaging` only, no host permissions,
 * no cookies or webRequest, content scripts on https://x.com only, and an extension-page CSP that
 * allows no remote script, eval, wasm, or network connection.
 */
export function buildManifest(version: string): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: "Citspark capture",
    description: "Saves your X bookmarks and likes to the Citspark desktop app on this computer.",
    version,
    minimum_chrome_version: "116",
    key: EXTENSION_PUBLIC_KEY,
    permissions: ["nativeMessaging"],
    background: { service_worker: "background.js", type: "module" },
    content_scripts: [
      {
        matches: ["https://x.com/*"],
        js: ["observer.js"],
        run_at: "document_start",
        world: "MAIN",
      },
      { matches: ["https://x.com/*"], js: ["content.js"], run_at: "document_start" },
    ],
    action: { default_popup: "popup.html", default_title: "Citspark capture" },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; base-uri 'none'; connect-src 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  };
}
