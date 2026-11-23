// A minimal desktop core for the T02 harness and the owner's local validation (no Electron yet; M2-01
// owns the real shell). It runs the real IpcServer, pairing controller, capture handlers and store.
import Database from "better-sqlite3";
import {
  captureHandlers,
  IpcServer,
  MemoryClientRegistry,
  PairingController,
  type MethodHandler,
  type PairingPresenter,
} from "@citspark/core";
import { generateStaticKeyPair } from "@citspark/ipc";
import { CaptureStore, JobStore, migrate } from "@citspark/store";

export interface DevDesktop {
  server: IpcServer;
  registry: MemoryClientRegistry;
  pairing: PairingController;
  /** Swap the library database (one per harness scenario). */
  useDatabase(path: string): Database.Database;
  db(): Database.Database;
  close(): Promise<void>;
}

export async function startDevDesktop(o: {
  socketPath: string;
  dbPath: string;
  present: PairingPresenter;
}): Promise<DevDesktop> {
  let db = open(o.dbPath);
  let handlers = captureHandlers({ db });
  const delegating: Record<string, MethodHandler> = Object.fromEntries(
    Object.entries(handlers).map(([method, h]) => [
      method,
      {
        scope: h.scope,
        mutation: h.mutation,
        handle: (payload, ctx) => handlers[method]!.handle(payload, ctx),
      } satisfies MethodHandler,
    ]),
  );
  const registry = new MemoryClientRegistry();
  const pairing = new PairingController({ present: o.present });
  const server = new IpcServer({
    staticKeyPair: generateStaticKeyPair(),
    coreVersion: "0.0.0-dev",
    registry,
    pairing,
    handlers: delegating,
  });
  await server.listen(o.socketPath);
  return {
    server,
    registry,
    pairing,
    useDatabase(path) {
      db.close();
      db = open(path);
      handlers = captureHandlers({ db });
      return db;
    },
    db: () => db,
    async close() {
      await server.close();
      db.close();
    },
  };
}

function open(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Content-free capture report (owner gate, B8): counts, states, adapter versions, and termination
 * evidence only. No post text, IDs, handles, URLs, or cursors.
 */
export function contentFreeReport(db: Database.Database): unknown[] {
  const jobs = new JobStore(db);
  const capture = new CaptureStore(db, jobs);
  const rows = db.prepare("SELECT id FROM job WHERE kind = 'x-capture' ORDER BY rowid").all() as {
    id: string;
  }[];
  return rows.map(({ id }, n) => {
    const job = jobs.get(id);
    const s = capture.summary(id);
    const collection = job.collectionId?.startsWith("bookmark_folder:")
      ? "bookmark_folder"
      : job.collectionId;
    return {
      job: n + 1,
      collection,
      state: job.state,
      stopReason: (job.stopReason ?? "").replace(/pass \S+/g, "pass <id>"),
      pages: s.pages,
      passes: s.passes,
      distinctSources: s.distinctSources,
      adapters: s.adapters,
      end: s.end ? { seq: s.end.seq, adapter: s.end.adapter } : null,
    };
  });
}
