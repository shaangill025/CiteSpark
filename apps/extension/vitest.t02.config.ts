import { defineConfig } from "vitest/config";

// T02 browser harness (M1-08). Needs `pnpm build` and a Playwright Chromium; run with
// `pnpm --dir apps/extension test:t02`. Kept out of the default unit run.
export default defineConfig({
  test: {
    include: ["test/t02/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
