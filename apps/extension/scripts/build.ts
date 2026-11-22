// Bundles the MV3 extension with esbuild: everything local, nothing fetched at run time (ADR 0005).
// `dist/` is the shipped build. `dist-test/` differs only in pacing constants (T02 harness speed).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { buildManifest } from "../src/manifest.ts";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

const flavors = [
  { dir: "dist", flavor: "release" },
  { dir: "dist-test", flavor: "test" },
] as const;

for (const { dir, flavor } of flavors) {
  const out = join(root, dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const common = {
    bundle: true,
    platform: "browser" as const,
    target: "chrome116",
    legalComments: "none" as const,
    minify: false,
    sourcemap: false,
    logLevel: "warning" as const,
    // The strict CSP (`script-src 'self'`, no 'wasm-unsafe-eval') forbids WebAssembly, and the
    // sodium-javascript hash/stream packages compile WASM at module load when it exists; that throw
    // aborted the whole service worker. Every one of them guards on `typeof WebAssembly` and keeps a
    // pure-JS implementation, so the bundle sees no WebAssembly at all (ADR 0011: same algorithms).
    define: { __CITSPARK_FLAVOR__: JSON.stringify(flavor), WebAssembly: "undefined" },
    // sodium-universal maps sodium-native to the pure-JS sodium-javascript for browsers (ADR 0011).
    alias: { "sodium-native": "sodium-javascript" },
    nodePaths: [join(root, "node_modules")],
  };
  await build({
    ...common,
    entryPoints: { background: join(root, "src/background/main.ts") },
    format: "esm",
    outdir: out,
  });
  await build({
    ...common,
    entryPoints: {
      observer: join(root, "src/observer/main-world.ts"),
      content: join(root, "src/content/isolated.ts"),
      popup: join(root, "src/popup/popup.ts"),
    },
    format: "iife",
    outdir: out,
  });
  cpSync(join(root, "src/popup/popup.html"), join(out, "popup.html"));
  cpSync(join(root, "src/popup/popup.css"), join(out, "popup.css"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(buildManifest(pkg.version), null, 2));
}
