import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drives the real Electron app (no browser download needed). Run `pnpm --filter @citspark/desktop build` first.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  // Traces and failure output stay outside the repository.
  outputDir: join(tmpdir(), "citspark-playwright-results"),
});
