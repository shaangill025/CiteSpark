import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Plain-JS Node scripts (.mjs/.cjs): build tooling, the packaged smoke and test fixtures.
const nodeGlobals = Object.fromEntries(
  [
    "process",
    "console",
    "Buffer",
    "URL",
    "module",
    "require",
    "__dirname",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
  ].map((name) => [name, "readonly"]),
);

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "prototypes/**",
      "coverage/**",
      // Desktop build output (staged app, packaged installers) and Playwright artifacts.
      "apps/desktop/build/**",
      "apps/desktop/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.mjs", "**/*.cjs"], languageOptions: { globals: nodeGlobals } },
  // The packaged smoke runs some callbacks inside the renderer via page.evaluate.
  {
    files: ["apps/desktop/scripts/packaged-smoke.mjs"],
    languageOptions: { globals: { window: "readonly", location: "readonly" } },
  },
);
