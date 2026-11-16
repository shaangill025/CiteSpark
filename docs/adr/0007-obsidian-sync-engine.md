# 0007. Obsidian sync engine

Status: Decided.
Requirements: SYN-01 to SYN-06, SEC-06, DAT-03, DAT-04, MIG-01, MIG-02, Q03 to Q08, Q51, Q52, T04, T07

## Context

Two-way sync must work without the plugin (SYN-01). It must tell moves, renames, edits, and duplicates apart, merge non-conflicting edits automatically, and keep conflicting variants for review while other notes continue (SYN-03). Watcher events are only hints (SYN-05). Markdown must stay readable without Citspark (SYN-06). Captured originals never change (SYN-02).

## Options

| Criterion | Three-way merge with stored base | CRDT (Automerge, Yjs) | Last-write-wins | Git repository in the vault |
|---|---|---|---|---|
| Works on plain Markdown edited by any tool | Yes. Base is a stored snapshot. | No. Needs a CRDT history file next to each note, and external edits arrive as whole-file replacements. | Yes. | Yes. |
| Conflicts kept for review | Yes. | Merges everything, including conflicts the spec says to keep. | No. Violates SYN-03. | Yes, through conflict markers in the file. |
| Vault footprint | Frontmatter only. | Extra files. | Frontmatter only. | `.git` directory, interferes with users' own sync. |
| Metadata conflicts | Per-key merge, same-key changes become conflicts. | Silent merge. | Silent overwrite. | Line-based, YAML-unaware. |

## Decision

**Note format (SYN-06)**

```yaml
---
citspark:
  schema: 1
  id: 01J9Z3S7M8Q4V6X2B5N0C1D7EF   # ULID, stable for the life of the note
  source: x:post:1849302746150912345  # namespaced source ID, string
  kind: source | annotation | generated
  managed: true
---
```

Body sections are delimited by HTML comments, which render invisibly in Obsidian and survive other editors:

```md
<!-- citspark:source:begin v=01J9... -->  original capture, read-only  <!-- citspark:source:end -->
<!-- citspark:user:begin -->  user notes  <!-- citspark:user:end -->
<!-- citspark:generated:begin -->  labeled AI output  <!-- citspark:generated:end -->
```

Text outside the markers belongs to the user. Edits inside the source section never change the captured original (SYN-02). They become a user-authored version for review.

**State per note (`sync_binding`)**: stable note ID, vault ID, current path, base content hash and base content (the last common revision), last written hash, unlink and suppression state.

**Reconcile loop**

1. Scan included scope (managed notes and explicit includes, SYN-01, Q07) and read frontmatter IDs. Use chokidar events only to schedule scans (SYN-05). Always do a full reconcile at startup.
2. Identify each file by ID first, then by content hash. Same ID at a new path is a move or rename. The same ID in two files is a duplicate and becomes a conflict. A known ID with no file is a deletion: unlink and suppress re-creation (SYN-04).
3. For each changed note: three-way merge base, vault, and library per section with diff3 (node-diff3, MIT). Frontmatter merges per key. Concurrent changes to the same key are a conflict, never last-write-wins (SYN-03).
4. A clean merge writes atomically: write a temp file in the same directory, fsync, re-check the target's hash still matches what was read, then rename. If the hash changed, start over for that note.
5. A conflict stores both variants and the base in the library, leaves the vault file untouched, and moves on to the next note.
6. Record the written hash and a transaction ID. Watcher events for our own writes are recognized by hash and ignored, which prevents feedback loops (SYN-05).

**Safety**: resolve every path with `realpath` and refuse anything outside the vault root or authorized scope (SYN-05, SEC-06). Never create or overwrite a file that is not a managed note. Trash in Citspark unlinks and suppresses the vault note but does not delete it (DAT-03, Q51).

## Consequences

- The base content is stored per note, roughly doubling storage for synced notes. Compress it.
- Merges happen at line granularity inside sections. Two edits to the same line conflict even if they touch different words. This errs on the side of review.
- Migration of the owner's existing vault runs as a dry run first (MIG-01, MIG-02), producing a report of IDs to assign and files to touch.

## Still to validate

- T04 scenarios with fast-check generated edit sequences in the M2 sync engine layer, plus a filesystem harness for rename, move, interrupted writes, and external sync tools.
- Atomic rename semantics on Windows when Obsidian or a sync client holds the file open.
