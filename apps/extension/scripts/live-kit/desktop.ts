// The desktop core for the owner's live run (no Electron yet; M2-01 owns the real shell). Runs the
// real IPC server, pairing, capture handlers and store against a persistent library, shows the
// pairing prompt in this terminal, and logs content-free job state transitions for the evidence file.
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { startDevDesktop } from "../dev-desktop-lib.ts";
import { sanitizeStop } from "./evidence.ts";
import type { KitLayout } from "./paths.ts";

export async function runDesktop(
  l: KitLayout,
  out: (m: string) => void = console.log,
): Promise<void> {
  mkdirSync(l.libraryDir, { recursive: true });
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const desktop = await startDevDesktop({
    socketPath: l.socketPath,
    dbPath: l.libraryPath,
    present: (_prompt, dialog) => {
      out("\nPAIRING REQUEST from the extension.");
      out("Type the 6-digit code the extension popup shows, then press Enter:");
      const onLine = (line: string) => {
        const r = dialog.submit(line.trim());
        if (r === "ok") {
          out(
            `Code accepted. Type this code into the extension popup: ${dialog.desktopCode() ?? "?"}`,
          );
          rl.off("line", onLine);
        } else out(`Code ${r}.${r === "wrong" ? " Try again:" : ""}`);
      };
      rl.on("line", onLine);
      return () => rl.off("line", onLine);
    },
  });
  out(`Citspark desktop core running. Library: ${l.libraryPath}`);
  out(
    "Leave this window open. Ctrl+C stops it. (Pairing is held in memory: re-pair after a restart.)",
  );

  const last = new Map<string, string>();
  const ordinals = new Map<string, number>();
  const poll = () => {
    const rows = desktop
      .db()
      .prepare("SELECT id, state, stop_reason FROM job WHERE kind = 'x-capture' ORDER BY rowid")
      .all() as { id: string; state: string; stop_reason: string | null }[];
    for (const r of rows) {
      if (!ordinals.has(r.id)) ordinals.set(r.id, ordinals.size + 1);
      const stop = sanitizeStop(r.stop_reason);
      const key = `${r.state}|${stop}`;
      if (last.get(r.id) === key) continue;
      last.set(r.id, key);
      appendFileSync(
        l.transitionsPath,
        JSON.stringify({
          t: new Date().toISOString(),
          job: ordinals.get(r.id),
          state: r.state,
          stop,
        }) + "\n",
      );
      out(`job ${ordinals.get(r.id)}: ${r.state}${stop ? ` (${stop})` : ""}`);
    }
  };
  const timer = setInterval(() => {
    try {
      poll();
    } catch {
      /* database busy: next tick */
    }
  }, 500);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  clearInterval(timer);
  rl.close();
  await desktop.close();
}
