export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Safe to apply after a higher-numbered migration is already recorded (a gap left by a build
   * that shipped without it). Only for additive statements that no later migration depends on.
   * Without it, `migrate` refuses such a gap instead of applying SQL out of order.
   */
  orderIndependent?: boolean;
}

// Platform identifiers are TEXT: 19-digit X IDs exceed Number.MAX_SAFE_INTEGER (DAT-01, CAP-02).
const V1 = `
CREATE TABLE source (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  platform_id TEXT,
  canonical_url TEXT,
  author_id TEXT,
  author_handle TEXT,
  trashed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE UNIQUE INDEX source_platform ON source (source_type, platform_id) WHERE platform_id IS NOT NULL;

CREATE TABLE source_version (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  original_status TEXT NOT NULL DEFAULT 'original' CHECK (original_status IN ('original', 'translation')),
  completeness TEXT NOT NULL DEFAULT 'unknown',
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source_id, content_hash),
  UNIQUE (id, source_id)
) STRICT;

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  account_id TEXT,
  collection_id TEXT,
  cursor TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  progress TEXT,
  stop_reason TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE observation (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  version_id INTEGER NOT NULL,
  job_id TEXT REFERENCES job(id),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  method TEXT NOT NULL,
  adapter_version TEXT,
  availability TEXT NOT NULL DEFAULT 'available',
  evidence TEXT,
  FOREIGN KEY (version_id, source_id) REFERENCES source_version(id, source_id)
) STRICT;

CREATE TABLE collection (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (account_id, id)
) STRICT;

CREATE TABLE membership (
  account_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id),
  first_observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  first_job_id TEXT REFERENCES job(id),
  last_job_id TEXT REFERENCES job(id),
  PRIMARY KEY (account_id, collection_id, source_id),
  FOREIGN KEY (account_id, collection_id) REFERENCES collection(account_id, id)
) STRICT;

CREATE TABLE relationship (
  id INTEGER PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  version_id INTEGER REFERENCES source_version(id),
  origin TEXT NOT NULL CHECK (origin IN ('captured', 'inferred', 'user')),
  approval_state TEXT NOT NULL DEFAULT 'none' CHECK (approval_state IN ('none', 'proposed', 'approved', 'rejected')),
  evidence TEXT
) STRICT;

CREATE TABLE privacy_policy (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('local_only', 'provider_authorized')),
  provider TEXT,
  provenance TEXT
) STRICT;

CREATE TABLE annotation (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES source(id),
  base_revision INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  privacy_policy_id TEXT REFERENCES privacy_policy(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE annotation_revision (
  annotation_id TEXT NOT NULL REFERENCES annotation(id),
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (annotation_id, revision)
) STRICT;

CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  content_hash TEXT NOT NULL,
  blob_path TEXT,
  mime_type TEXT,
  privacy_policy_id TEXT REFERENCES privacy_policy(id)
) STRICT;

CREATE TABLE derivation (
  id INTEGER PRIMARY KEY,
  media_id INTEGER NOT NULL REFERENCES media(id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  segment_start_ms INTEGER,
  segment_end_ms INTEGER,
  model_fingerprint TEXT,
  attribution TEXT,
  privacy_policy_id TEXT REFERENCES privacy_policy(id)
) STRICT;

CREATE TABLE index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_generation INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO index_state (id, active_generation) VALUES (1, 0);

CREATE TABLE chunk (
  id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES source_version(id),
  char_start INTEGER,
  char_end INTEGER,
  derivation_id INTEGER REFERENCES derivation(id),
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  document_type TEXT NOT NULL,
  index_generation INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX chunk_version ON chunk (version_id);

CREATE TABLE sync_binding (
  library_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  source_id TEXT REFERENCES source(id),
  path TEXT NOT NULL,
  last_common_hash TEXT,
  suppression TEXT NOT NULL DEFAULT 'none' CHECK (suppression IN ('none', 'unlinked', 'deleted')),
  PRIMARY KEY (library_id, vault_id, note_id)
) STRICT;

CREATE TABLE answer (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  text TEXT NOT NULL,
  provider_config TEXT,
  evidence_refs TEXT NOT NULL,
  policy_scope TEXT,
  index_generation INTEGER,
  action_trace TEXT,
  validation_outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE backup_manifest (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  library_id TEXT NOT NULL,
  file_hashes TEXT NOT NULL,
  media_inventory TEXT,
  encryption TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
`;

// Sync engine core (M2-04, ADR 0007): binding state, compressed base content, write identity, and
// conflict/review records. Statements only add columns and tables. Published version numbers are
// never renumbered: a database from the jobs-only build records [1, 3] and receives this migration
// as a recorded gap (see `migrate`).
const SYNC_CORE = `
ALTER TABLE sync_binding ADD COLUMN state TEXT NOT NULL DEFAULT 'bound' CHECK (state IN ('bound', 'unlinked', 'conflict'));
ALTER TABLE sync_binding ADD COLUMN base_content BLOB;
ALTER TABLE sync_binding ADD COLUMN last_written_hash TEXT;
ALTER TABLE sync_binding ADD COLUMN last_txn_id TEXT;

CREATE TABLE sync_conflict (
  id INTEGER PRIMARY KEY,
  library_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  note_id TEXT,
  path TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('merge', 'duplicate_id', 'delete_vs_edit', 'restore_candidate', 'unbound_file', 'source_edit')),
  base_text TEXT,
  vault_text TEXT,
  library_text TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT
) STRICT;
CREATE INDEX sync_conflict_open ON sync_conflict (library_id, vault_id, status);
`;

// Capture commit bookkeeping (CAP-03, CAP-06). A pass is one scroll of a collection from the top;
// replay checks are keyed on the pass and the cursor a page started from (ADR 0005). Version 4
// follows the published sync-core (2) and job-lease-generation (3) migrations; numbers are never
// reused. Only additive statements, so existing rows are preserved.
const CAPTURE_COMMIT = `
CREATE TABLE capture_pass (
  job_id TEXT NOT NULL REFERENCES job(id),
  pass_id TEXT NOT NULL,
  cursor TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT,
  started_at TEXT NOT NULL,
  PRIMARY KEY (job_id, pass_id)
) STRICT;

CREATE TABLE capture_page (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL,
  pass_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  page_key TEXT NOT NULL,
  cursor_in TEXT,
  cursor_out TEXT,
  content_hash TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  new_records INTEGER NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  FOREIGN KEY (job_id, pass_id) REFERENCES capture_pass(job_id, pass_id),
  UNIQUE (job_id, pass_id, page_key),
  UNIQUE (job_id, pass_id, seq)
) STRICT;

ALTER TABLE observation ADD COLUMN capture_page_id INTEGER REFERENCES capture_page(id);
-- One capture observation per job and version, so a fresh pass re-reading committed records adds
-- nothing (ADR 0005). Scoped to capture rows: schemas 1-3 allowed repeated observations of a version
-- by one job (each with its own time and evidence), and those rows are kept unchanged.
CREATE UNIQUE INDEX observation_capture_job_version ON observation (job_id, version_id) WHERE capture_page_id IS NOT NULL;
`;

// Media store (M1-10; MED-01, MED-04, Q28). Version 5 follows the published sync-core (2),
// job-lease-generation (3) and capture-commit (4) migrations; numbers are never reused. An unmerged
// PR #9 preview numbered this 2; such a database records 2 as "media-store" and is refused by name.
// Only additive statements. Schema 1-4 never constrained media (source_id, content_hash), so new
// duplicates are refused by trigger while any legacy duplicate rows are kept unchanged. Downloads are
// claimed by (job, lease generation) so concurrent media jobs never share a partial file.
const MEDIA_STORE = `
CREATE TABLE blob (
  content_hash TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  ref_count INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX media_source_hash ON media (source_id, content_hash);
CREATE TRIGGER media_source_hash_insert BEFORE INSERT ON media
WHEN EXISTS (SELECT 1 FROM media WHERE source_id = NEW.source_id AND content_hash = NEW.content_hash)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: media.source_id, media.content_hash');
END;
CREATE TRIGGER media_source_hash_update BEFORE UPDATE OF source_id, content_hash ON media
WHEN EXISTS (SELECT 1 FROM media WHERE id <> NEW.id AND source_id = NEW.source_id AND content_hash = NEW.content_hash)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: media.source_id, media.content_hash');
END;

CREATE TABLE media_download (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'downloading', 'paused_budget', 'paused_disk', 'complete', 'failed')),
  bytes_received INTEGER NOT NULL DEFAULT 0 CHECK (bytes_received >= 0),
  total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
  etag TEXT,
  mime_type TEXT,
  media_id INTEGER REFERENCES media(id),
  error TEXT,
  claim_job_id TEXT REFERENCES job(id),
  claim_generation INTEGER,
  CHECK ((claim_job_id IS NULL) = (claim_generation IS NULL)),
  CHECK (state <> 'complete' OR media_id IS NOT NULL),
  UNIQUE (source_id, url)
) STRICT;
CREATE INDEX media_download_state ON media_download (state, id);
`;

// Linked sources (M1-11; ENR-01, ENR-02, ENR-03, Q16). Version 6 follows the published sync-core
// (2), job-lease-generation (3), capture-commit (4) and media-store (5) migrations; numbers are never
// reused. The unmerged PR #13 preview numbered this 3; such a database records 3 as "linked-sources"
// and is refused by name. Only additive statements.
const LINKED_SOURCES = `
CREATE TABLE linked_fetch (
  id INTEGER PRIMARY KEY,
  original_url TEXT NOT NULL UNIQUE,
  source_id TEXT REFERENCES source(id),
  final_url TEXT,
  canonical_url TEXT,
  redirect_chain TEXT,
  title TEXT,
  content_hash TEXT,
  extraction_method TEXT,
  http_status INTEGER,
  gap_reason TEXT,
  gap_detail TEXT,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((source_id IS NULL) = (gap_reason IS NOT NULL))
) STRICT;

CREATE TABLE link_ref (
  source_id TEXT NOT NULL REFERENCES source(id),
  original_url TEXT NOT NULL REFERENCES linked_fetch(original_url),
  PRIMARY KEY (source_id, original_url)
) STRICT;
`;

// Trash and purge (M1-12; DAT-03, DAT-04, Q50, SYN-04). Version 7 follows the published sync-core
// (2), job-lease-generation (3), capture-commit (4), media-store (5) and linked-sources (6)
// migrations; numbers are never reused. The unmerged PR #16 preview numbered this 4 (after preview
// capture 2 and media 3); such a database records 4 as "trash-purge" and is refused by name. Only
// additive statements. A purged source keeps a tombstone row so recapture stays suppressed and
// retained citations report it unavailable. `purge_file` queues file removals a purge committed,
// so a failed unlink or a crash after commit is retried instead of stranding source media.
// Downloads enqueued for a trashed or purged source start suppressed; media is never attached to a
// purged source.
const TRASH_PURGE = `
ALTER TABLE source ADD COLUMN purged_at TEXT;

CREATE TABLE purge_file (
  path TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  kind TEXT NOT NULL CHECK (kind IN ('blob', 'partial')),
  queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER media_download_suppressed AFTER INSERT ON media_download
WHEN EXISTS (SELECT 1 FROM source WHERE id = NEW.source_id AND (trashed_at IS NOT NULL OR purged_at IS NOT NULL))
BEGIN
  UPDATE media_download SET state = 'failed',
    error = CASE WHEN (SELECT purged_at FROM source WHERE id = NEW.source_id) IS NULL
      THEN 'source_trashed' ELSE 'source_purged' END
  WHERE id = NEW.id;
END;

CREATE TRIGGER media_purged_source BEFORE INSERT ON media
WHEN EXISTS (SELECT 1 FROM source WHERE id = NEW.source_id AND purged_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'source was purged');
END;

CREATE VIEW active_source AS SELECT * FROM source WHERE trashed_at IS NULL AND purged_at IS NULL;

CREATE VIEW active_version AS
  SELECT v.* FROM source_version v JOIN source s ON s.id = v.source_id
  WHERE s.trashed_at IS NULL AND s.purged_at IS NULL;

CREATE VIEW active_chunk AS
  SELECT c.* FROM chunk c
  JOIN source_version v ON v.id = c.version_id
  JOIN source s ON s.id = v.source_id
  WHERE s.trashed_at IS NULL AND s.purged_at IS NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial-schema", sql: V1 },
  { version: 2, name: "sync-core", sql: SYNC_CORE, orderIndependent: true },
  {
    version: 3,
    name: "job-lease-generation",
    sql: "ALTER TABLE job ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;",
  },
  { version: 4, name: "capture-commit", sql: CAPTURE_COMMIT },
  { version: 5, name: "media-store", sql: MEDIA_STORE },
  { version: 6, name: "linked-sources", sql: LINKED_SOURCES },
  { version: 7, name: "trash-purge", sql: TRASH_PURGE },
];
