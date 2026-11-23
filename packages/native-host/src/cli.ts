#!/usr/bin/env node
import { connectIpc } from "@citspark/ipc/node";
import { loadHostConfig, resolveConfigPath, runHost } from "./host.ts";

// The installer (install.ts) writes the config, a launcher that points CITSPARK_HOST_CONFIG at it,
// and the per-browser host manifest.
const config = await loadHostConfig(resolveConfigPath(process.env, import.meta.dirname)).catch(
  () => {
    process.exit(1);
  },
);
process.exitCode = await runHost({
  args: process.argv.slice(2),
  config,
  stdin: process.stdin,
  stdout: process.stdout,
  connect: connectIpc,
});
