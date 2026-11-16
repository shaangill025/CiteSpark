#!/usr/bin/env node
import { join } from "node:path";
import { connectIpc } from "@citspark/ipc/node";
import { loadHostConfig, runHost } from "./host.ts";

// The installer (M1-08) writes native-host.json beside this file and the per-browser host manifest.
const config = await loadHostConfig(join(import.meta.dirname, "native-host.json")).catch(() => {
  process.exit(1);
});
process.exitCode = await runHost({
  args: process.argv.slice(2),
  config,
  stdin: process.stdin,
  stdout: process.stdout,
  connect: connectIpc,
});
