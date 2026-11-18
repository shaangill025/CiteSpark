import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ErrorCode,
  jsonByteLength,
  negotiateVersion,
  protocolError,
  RequestSchema,
  SUPPORTED_VERSIONS,
  UI_PROTOCOL_LIMITS,
  UiHelloSchema,
  type ProtocolErrorBody,
  type UiHelloReply,
} from "@citspark/protocol";
import { MIGRATIONS, MigrationStateError, migrate } from "@citspark/store";

/** The library database inside the data directory the shell passes in. */
export const LIBRARY_FILE = "library.sqlite";

export type CoreStartFailure =
  | "data_dir_invalid"
  | "library_unreadable"
  | "library_newer"
  | "library_needs_backup"
  | "library_inconsistent";

const START_MESSAGES: Record<CoreStartFailure, string> = {
  data_dir_invalid: "Citspark could not use its data folder.",
  library_unreadable: "The library file could not be read as a Citspark library.",
  library_newer: "The library was written by a newer Citspark. Update Citspark to open it.",
  library_needs_backup:
    "The library needs an upgrade. Upgrades run only after a backup, which this preview cannot take yet.",
  library_inconsistent: "The library's recorded schema does not match this build.",
};

/** Why the core could not start. `message` is safe to show; it never contains paths or library content. */
export class CoreStartError extends Error {
  override name = "CoreStartError";
  readonly code: CoreStartFailure;
  constructor(code: CoreStartFailure) {
    super(START_MESSAGES[code]);
    this.code = code;
  }
}

export interface DesktopCoreOptions {
  /** Absolute directory that holds the library. The shell passes a directory under Electron's userData. */
  dataDir: string;
  coreVersion: string;
}

export interface CoreStatus {
  state: "ready";
  core: { version: string; pid: number; startedAt: string };
  protocol: { version: number };
  library: { schemaVersion: number; created: boolean };
  memory: { rssBytes: number; heapUsedBytes: number };
}

type Json = ReturnType<typeof JSON.parse>;
type Response =
  | { v: number; id: string; ok: true; result: Json }
  | { v: number; id: string | null; ok: false; error: ProtocolErrorBody };

interface Method {
  readonly mutation: boolean;
  run(core: DesktopCore): Json;
}

// Null prototype: a method name such as "__proto__" or "constructor" never resolves to anything.
const METHODS: Readonly<Record<string, Method>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Method>, {
    "core.status": {
      mutation: false,
      run: (core: DesktopCore) => core.status() as unknown as Json,
    },
  }),
);

const LATEST = Math.max(0, ...MIGRATIONS.map((m) => m.version));

class NeedsBackup extends Error {}

/**
 * The desktop core as the shell hosts it (ADR 0001): plain Node, no Electron imports. It owns the library
 * database and answers the renderer's protocol messages. The Electron utility process runs it through
 * `runCoreHost`; tests run it directly.
 */
export class DesktopCore {
  readonly #db: Database.Database;
  readonly #coreVersion: string;
  readonly #startedAt = new Date().toISOString();
  readonly #schemaVersion: number;
  readonly #created: boolean;
  #version: number | undefined;
  #closed = false;

  private constructor(
    db: Database.Database,
    coreVersion: string,
    schemaVersion: number,
    created: boolean,
  ) {
    this.#db = db;
    this.#coreVersion = coreVersion;
    this.#schemaVersion = schemaVersion;
    this.#created = created;
  }

  /** @internal Use {@link startDesktopCore}. */
  static open(opts: DesktopCoreOptions): DesktopCore {
    if (!isAbsolute(opts.dataDir) || !existsSync(opts.dataDir)) {
      throw new CoreStartError("data_dir_invalid");
    }
    const file = join(opts.dataDir, LIBRARY_FILE);
    const created = !existsSync(file);
    let db: Database.Database;
    try {
      db = new Database(file);
    } catch {
      throw new CoreStartError("library_unreadable");
    }
    try {
      const recorded = recordedVersion(db);
      if (recorded > LATEST) throw new CoreStartError("library_newer");
      const result = migrate(db, {
        backup: () => {
          throw new NeedsBackup();
        },
      });
      return new DesktopCore(db, opts.coreVersion, result.version, created);
    } catch (e) {
      db.close();
      if (e instanceof CoreStartError) throw e;
      if (e instanceof NeedsBackup) throw new CoreStartError("library_needs_backup");
      if (e instanceof MigrationStateError) {
        throw new CoreStartError("library_inconsistent");
      }
      throw new CoreStartError("library_unreadable");
    }
  }

  status(): CoreStatus {
    const mem = process.memoryUsage();
    return {
      state: "ready",
      core: { version: this.#coreVersion, pid: process.pid, startedAt: this.#startedAt },
      protocol: { version: this.#version ?? SUPPORTED_VERSIONS.max },
      library: { schemaVersion: this.#schemaVersion, created: this.#created },
      memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
    };
  }

  /** Handles one renderer message: `ui.hello` first, then protocol requests. Never throws. */
  async handle(message: unknown): Promise<UiHelloReply | Response> {
    const id = requestIdOf(message);
    const size = jsonByteLength(message);
    if (size === undefined || size > UI_PROTOCOL_LIMITS.maxMessageBytes) {
      return this.#error(id, ErrorCode.FrameTooLarge, "The message is too large.");
    }
    if (this.#closed) return this.#error(id, ErrorCode.Internal, "The core is shutting down.");
    if ((message as { type?: unknown } | null)?.type === "ui.hello") return this.#hello(message);

    const parsed = RequestSchema.safeParse(message);
    if (!parsed.success) return this.#error(id, ErrorCode.InvalidMessage, "Malformed request.");
    const req = parsed.data;
    if (this.#version === undefined) {
      return this.#error(req.id, ErrorCode.Unauthorized, "Say hello before sending requests.");
    }
    if (req.v !== this.#version) {
      return this.#error(req.id, ErrorCode.Incompatible, "Wrong protocol version.");
    }
    const method = Object.hasOwn(METHODS, req.method) ? METHODS[req.method] : undefined;
    if (!method) return this.#error(req.id, ErrorCode.NotFound, `Unknown method ${req.method}.`);
    if (method.mutation !== req.mutation) {
      return this.#error(
        req.id,
        ErrorCode.InvalidMessage,
        "The mutation flag does not match the method.",
      );
    }
    try {
      return { v: this.#version, id: req.id, ok: true, result: method.run(this) };
    } catch {
      return this.#error(req.id, ErrorCode.Internal, "Citspark hit an internal error.");
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #hello(message: unknown): UiHelloReply {
    const parsed = UiHelloSchema.safeParse(message);
    if (!parsed.success) {
      return {
        type: "ui.hello.error",
        error: protocolError(ErrorCode.InvalidMessage, "Malformed hello."),
      };
    }
    const negotiated = negotiateVersion(parsed.data.versions, SUPPORTED_VERSIONS);
    if (!negotiated.ok) {
      this.#version = undefined;
      return { type: "ui.hello.error", error: negotiated.error };
    }
    this.#version = negotiated.version;
    return {
      type: "ui.hello.ok",
      version: negotiated.version,
      core: { version: this.#coreVersion },
    };
  }

  #error(id: string | null, code: ErrorCode, message: string): Response {
    return {
      v: this.#version ?? SUPPORTED_VERSIONS.max,
      id,
      ok: false,
      error: protocolError(code, message),
    };
  }
}

/** Opens (creating if needed) and migrates the library, then returns the running core. */
export async function startDesktopCore(opts: DesktopCoreOptions): Promise<DesktopCore> {
  return DesktopCore.open(opts);
}

function recordedVersion(db: Database.Database): number {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'")
    .get();
  if (!table) return 0;
  const row = db.prepare("SELECT max(version) AS v FROM schema_migration").get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

function requestIdOf(message: unknown): string | null {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : null;
}
