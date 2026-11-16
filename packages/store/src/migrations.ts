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
// replay checks are keyed on the pass and the cursor a page started from (ADR 0005).
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
CREATE UNIQUE INDEX observation_job_version ON observation (job_id, version_id) WHERE job_id IS NOT NULL;
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
];
