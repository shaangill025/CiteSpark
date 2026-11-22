/**
 * Messages between the service worker, the X tab's content script, and the popup. Observations
 * carry X's response bodies for recognized requests only; no message ever carries a cookie, a
 * header other than Retry-After, or a token (SEC-04).
 */
import type { RunStatus } from "../background/run.ts";
import type { LinkState } from "../background/link.ts";

export type FolderInfo = { folderId: string; name: string };

export interface UiState {
  link: LinkState | "checking";
  linkMessage?: string;
  pairing: { code?: string; awaitingDesktopCode: boolean; error?: string } | null;
  account: { accountId: string; handle: string } | null;
  xTab: boolean;
  folders: FolderInfo[];
  run: RunStatus | null;
  budget: { limit: number; used: number };
  flavor: string;
}

export type PopupCommand =
  | { type: "refresh"; tabId?: number }
  | { type: "pair" }
  | { type: "pairCode"; code: string }
  | { type: "pairCancel" }
  | { type: "start"; tabId: number; collection: string }
  | { type: "pause" }
  | { type: "cancel" }
  | { type: "setBudget"; limit: number };

export type TabCommand = { type: "scroll" };
