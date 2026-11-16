export interface Migration {
  version: number;
  name: string;
  sql: string;
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
  UNIQUE (source_id, content_hash)
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
  version_id INTEGER NOT NULL REFERENCES source_version(id),
  job_id TEXT REFERENCES job(id),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  method TEXT NOT NULL,
  adapter_version TEXT,
  availability TEXT NOT NULL DEFAULT 'available',
  evidence TEXT
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
  PRIMARY KEY (account_id, collection_id, source_id)
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

// Capture commit bookkeeping (CAP-03, CAP-06). A pass is one scroll of a collection from the top;
// replay checks are keyed on the pass and the cursor a page started from (ADR 0005).
const V2 = `
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

// Media store (MED-01..). Blobs are content-addressed and reference counted.
const V3 = `
CREATE TABLE blob (
  content_hash TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  ref_count INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX media_source_hash ON media (source_id, content_hash);

CREATE TABLE media_download (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'downloading', 'paused_budget', 'paused_disk', 'complete', 'failed')),
  bytes_received INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  etag TEXT,
  mime_type TEXT,
  media_id INTEGER REFERENCES media(id),
  error TEXT,
  UNIQUE (source_id, url)
) STRICT;
`;

// Trash and purge (DAT-03, DAT-04). A purged source keeps a tombstone row so recapture stays
// suppressed and retained citations resolve to "unavailable" rather than to another source.
const V4 = `
ALTER TABLE source ADD COLUMN purged_at TEXT;

CREATE VIEW active_source AS SELECT * FROM source WHERE trashed_at IS NULL;

CREATE VIEW active_version AS
  SELECT v.* FROM source_version v JOIN source s ON s.id = v.source_id WHERE s.trashed_at IS NULL;

CREATE VIEW active_chunk AS
  SELECT c.* FROM chunk c
  JOIN source_version v ON v.id = c.version_id
  JOIN source s ON s.id = v.source_id
  WHERE s.trashed_at IS NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial-schema", sql: V1 },
  { version: 2, name: "capture-commit", sql: V2 },
  { version: 3, name: "media-store", sql: V3 },
  { version: 4, name: "trash-purge", sql: V4 },
];
