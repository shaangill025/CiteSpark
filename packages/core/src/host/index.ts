// The core as the desktop shell hosts it. Plain Node: no Electron imports (ADR 0001).
export {
  CoreStartError,
  DesktopCore,
  LIBRARY_FILE,
  startDesktopCore,
  type CoreStartFailure,
  type CoreStatus,
  type DesktopCoreOptions,
} from "./core.ts";
export { runCoreHost, type HostEvent, type HostPort, type RunningHost } from "./run.ts";
export { UI_PROTOCOL_LIMITS } from "@citspark/protocol";
