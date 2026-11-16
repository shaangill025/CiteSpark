/** A file found in the scanned scope. `id` is `citspark.id` from its frontmatter, if any. */
export interface ScannedFile {
  path: string;
  id: string | null;
  /** Content hash of the whole file, as produced by `contentHash`. */
  hash: string;
}

export type BindingState = "bound" | "unlinked" | "conflict";

export interface KnownBinding {
  noteId: string;
  path: string;
  state: BindingState;
  /** Hash of the last common revision, or null before the first sync. */
  baseHash: string | null;
  /** Whether the library side changed since the base. Decides deletion versus conflict. */
  libraryChanged: boolean;
}

export type IdentityDecision =
  | { type: "present"; noteId: string; path: string }
  | { type: "moved"; noteId: string; from: string; to: string }
  /** No ID in the file; bound by an exact, unique base-hash match. */
  | { type: "matched_by_hash"; noteId: string; from: string; to: string }
  /** The same ID in several files. Listed for review; none is merged. */
  | { type: "duplicate"; noteId: string; paths: string[] }
  /** Possible ID-less copies exist: review the binding, never infer deletion or unlink it. */
  | { type: "ambiguous_hash"; noteId: string; path: string; paths: string[] }
  /** Gone from the vault with no library change since the base: unlink and suppress (SYN-04). */
  | { type: "deleted"; noteId: string; path: string }
  /** Gone from the vault but changed in the library: keep the library change, do not re-create. */
  | { type: "delete_vs_edit"; noteId: string; path: string }
  /** File carries the ID of an unlinked binding. Never re-bound automatically. */
  | { type: "restore_candidate"; noteId: string; path: string }
  /** Not bound. Listed for review, never bound automatically. */
  | {
      type: "unbound";
      path: string;
      id: string | null;
      reason: "unknown_id" | "no_id" | "ambiguous_hash";
    };

/**
 * Matches scanned files to bindings (SYN-01, ADR 0007 step 2). Files are identified by frontmatter
 * ID first. Hash matching is a fallback only for files with no ID, only against bindings whose ID
 * is absent from the scan, and only when exactly one file and one binding match the base hash.
 * Decisions are returned sorted by path, then note ID, so results do not depend on scan order.
 */
export function identify(
  files: readonly ScannedFile[],
  bindings: readonly KnownBinding[],
): IdentityDecision[] {
  const byNote = new Map(bindings.map((b) => [b.noteId, b]));
  if (byNote.size !== bindings.length) throw new Error("Duplicate note ID in bindings");
  const decisions: IdentityDecision[] = [];

  const withId = new Map<string, ScannedFile[]>();
  const noId: ScannedFile[] = [];
  for (const f of files) {
    if (f.id === null) noId.push(f);
    else withId.set(f.id, [...(withId.get(f.id) ?? []), f]);
  }

  for (const [id, group] of withId) {
    const binding = byNote.get(id);
    const first = group[0];
    if (!first) continue;
    if (group.length > 1) {
      decisions.push({ type: "duplicate", noteId: id, paths: group.map((f) => f.path).sort() });
    } else if (!binding) {
      decisions.push({ type: "unbound", path: first.path, id, reason: "unknown_id" });
    } else if (binding.state === "unlinked") {
      decisions.push({ type: "restore_candidate", noteId: id, path: first.path });
    } else if (binding.path === first.path) {
      decisions.push({ type: "present", noteId: id, path: first.path });
    } else {
      decisions.push({ type: "moved", noteId: id, from: binding.path, to: first.path });
    }
  }

  const missing = bindings.filter((b) => b.state !== "unlinked" && !withId.has(b.noteId));
  const candidates = new Map<ScannedFile, KnownBinding[]>();
  const claims = new Map<string, number>();
  for (const f of noId) {
    const hits = missing.filter((b) => b.baseHash !== null && b.baseHash === f.hash);
    candidates.set(f, hits);
    for (const b of hits) claims.set(b.noteId, (claims.get(b.noteId) ?? 0) + 1);
  }
  const matched = new Set<string>();
  for (const [f, hits] of candidates) {
    const only = hits[0];
    if (hits.length === 1 && only && claims.get(only.noteId) === 1) {
      matched.add(only.noteId);
      decisions.push({ type: "matched_by_hash", noteId: only.noteId, from: only.path, to: f.path });
    } else {
      decisions.push({
        type: "unbound",
        path: f.path,
        id: null,
        reason: hits.length > 0 ? "ambiguous_hash" : "no_id",
      });
    }
  }

  for (const b of missing) {
    if (matched.has(b.noteId)) continue;
    const paths = [...candidates]
      .filter(([, hits]) => hits.some((hit) => hit.noteId === b.noteId))
      .map(([file]) => file.path)
      .sort();
    if (paths.length > 0) {
      decisions.push({ type: "ambiguous_hash", noteId: b.noteId, path: b.path, paths });
      continue;
    }
    decisions.push({
      type: b.libraryChanged ? "delete_vs_edit" : "deleted",
      noteId: b.noteId,
      path: b.path,
    });
  }

  return decisions.sort((a, b) => {
    const pa = decisionPath(a);
    const pb = decisionPath(b);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}

function decisionPath(d: IdentityDecision): string {
  switch (d.type) {
    case "moved":
    case "matched_by_hash":
      return `${d.to}\0${d.noteId}`;
    case "duplicate":
      return `${d.paths[0] ?? ""}\0${d.noteId}`;
    case "unbound":
      return `${d.path}\0`;
    default:
      return `${d.path}\0${d.noteId}`;
  }
}
