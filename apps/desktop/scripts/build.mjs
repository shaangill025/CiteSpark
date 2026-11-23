// Builds the staged Electron app in build/app: the exact directory electron-builder packages and the
// Playwright tests launch. It contains only bundled output, the renderer, the platform's prebuilt SQLite
// addon and a package.json without dependencies, so nothing at runtime resolves into the development tree.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "build", "app");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// One CSP source: the main process sends it as a header, and the renderer's meta tag repeats it (Node 24
// strips the module's types on import). frame-ancestors is header-only and ignored in a meta tag.
const { CONTENT_SECURITY_POLICY } = await import(
  pathToFileURL(join(root, "src/main/security.ts")).href
);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });
mkdirSync(join(out, "renderer"), { recursive: true });

const common = {
  bundle: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
};
const results = await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, "src/main/main.ts")],
    outfile: join(out, "dist/main.cjs"),
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  }),
  build({
    ...common,
    // Sandboxed preload: no Node built-ins, only the `electron` module the sandbox provides.
    entryPoints: [join(root, "src/preload/preload.ts")],
    outfile: join(out, "dist/preload.cjs"),
    platform: "browser",
    format: "cjs",
    target: "chrome150",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: [join(root, "src/utility/core-entry.ts")],
    outfile: join(out, "dist/core.cjs"),
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: [join(root, "src/renderer/index.tsx")],
    outfile: join(out, "renderer/renderer.js"),
    platform: "browser",
    format: "iife",
    target: "chrome150",
    minify: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
]);

const metaCsp = CONTENT_SECURITY_POLICY.split("; ")
  .filter((d) => !d.startsWith("frame-ancestors"))
  .join("; ");
writeFileSync(
  join(out, "renderer/index.html"),
  readFileSync(join(root, "src/renderer/index.html"), "utf8").replace("__CSP__", metaCsp),
);
copyFileSync(join(root, "src/renderer/styles.css"), join(out, "renderer/styles.css"));

// better-sqlite3 13 is an N-API addon: one prebuilt binary per platform works under Node and Electron. The
// bundled JS looks for `<app>/prebuilds/<platform>-<arch>.node`; electron-builder unpacks it from the asar.
const require = createRequire(join(root, "../../packages/core/package.json"));
const sqliteDir = dirname(require.resolve("better-sqlite3/package.json"));
const target = `${process.platform}-${process.arch}`;
const prebuilt = join(sqliteDir, "prebuilds", `${target}.node`);
if (!existsSync(prebuilt)) throw new Error(`better-sqlite3 has no prebuilt addon for ${target}`);
mkdirSync(join(out, "prebuilds"), { recursive: true });
copyFileSync(prebuilt, join(out, "prebuilds", `${target}.node`));

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "citspark",
      productName: "Citspark",
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      author: "Citspark contributors",
      private: true,
      main: "dist/main.cjs",
    },
    null,
    2,
  )}\n`,
);

// Third-party notices for everything bundled into the app (ADR 0009). Electron's own notices
// (LICENSE, LICENSES.chromium.html) ship with the Electron runtime that electron-builder packages.
const packages = new Map();
for (const r of results) {
  for (const input of Object.keys(r.metafile.inputs)) {
    const abs = join(process.cwd(), input);
    const parts = abs.split(sep);
    const nm = parts.lastIndexOf("node_modules");
    if (nm < 0) continue;
    const nameParts = parts[nm + 1].startsWith("@") ? parts.slice(nm + 1, nm + 3) : [parts[nm + 1]];
    const dir = parts.slice(0, nm + 1 + nameParts.length).join(sep);
    if (!packages.has(dir))
      packages.set(dir, JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
  }
}
packages.set(sqliteDir, JSON.parse(readFileSync(join(sqliteDir, "package.json"), "utf8")));
const notices = [...packages.entries()]
  .sort(([, a], [, b]) => a.name.localeCompare(b.name))
  .map(([dir, p]) => {
    const file = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"].find((f) =>
      existsSync(join(dir, f)),
    );
    const text = file ? readFileSync(join(dir, file), "utf8").trim() : `License: ${p.license}`;
    return `${p.name}@${p.version} (${p.license})\n\n${text}\n`;
  });
writeFileSync(
  join(out, "THIRD_PARTY_NOTICES.txt"),
  `Third-party software bundled in Citspark ${pkg.version}\n\n${notices.join(`\n${"-".repeat(72)}\n\n`)}`,
);

console.log(
  `Built ${relative(process.cwd(), out)} (${target}); bundled packages: ${[...packages.values()]
    .map((p) => `${p.name}@${p.version}`)
    .sort()
    .join(", ")}`,
);
