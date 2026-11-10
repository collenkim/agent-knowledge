/** 배열 위치가 곧 PRAGMA user_version이다. 배포한 항목은 고치지 않고 뒤에 덧붙인다. */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE index_runs(run_id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL CHECK(status IN('running','published','unchanged','failed')), generation INTEGER, error_code TEXT, error_message TEXT, stats_json TEXT);
CREATE TABLE generations(generation INTEGER PRIMARY KEY, published_at TEXT NOT NULL, run_id INTEGER NOT NULL, parser_version TEXT NOT NULL, chunker_version TEXT NOT NULL, tokenizer_version TEXT NOT NULL, resolver_version TEXT NOT NULL, fingerprint TEXT NOT NULL, document_count INTEGER NOT NULL, item_count INTEGER NOT NULL);
CREATE TABLE generation_sources(generation INTEGER NOT NULL REFERENCES generations ON DELETE CASCADE, source_id TEXT NOT NULL, project_id TEXT NOT NULL, requested_ref TEXT NOT NULL, commit_sha TEXT NOT NULL, document_count INTEGER NOT NULL, skipped_json TEXT NOT NULL, PRIMARY KEY(generation, source_id)) WITHOUT ROWID;
CREATE TABLE documents(document_pk INTEGER PRIMARY KEY, source_id TEXT NOT NULL, project_id TEXT NOT NULL, path TEXT NOT NULL, blob_sha TEXT NOT NULL, content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, line_count INTEGER NOT NULL, parse_fingerprint TEXT NOT NULL, title TEXT NOT NULL, diagnostics_json TEXT NOT NULL, first_generation INTEGER NOT NULL, UNIQUE(source_id, path, blob_sha, parse_fingerprint));
CREATE TABLE generation_documents(generation INTEGER NOT NULL REFERENCES generations ON DELETE CASCADE, document_pk INTEGER NOT NULL REFERENCES documents, PRIMARY KEY(generation, document_pk)) WITHOUT ROWID;
CREATE INDEX generation_documents_doc ON generation_documents(document_pk);
CREATE TABLE items(item_pk INTEGER PRIMARY KEY, document_pk INTEGER NOT NULL REFERENCES documents ON DELETE CASCADE, ordinal INTEGER NOT NULL, item_id TEXT NOT NULL, key TEXT, anchor TEXT NOT NULL, unit TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, heading_path_json TEXT NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, declared_status_raw TEXT, declared_status TEXT, basis_refs_json TEXT NOT NULL, rule_json TEXT NOT NULL, mandatory INTEGER NOT NULL, aliases_json TEXT NOT NULL, applies_to_json TEXT NOT NULL, relations_json TEXT NOT NULL, UNIQUE(document_pk, ordinal));
CREATE UNIQUE INDEX items_doc_anchor ON items(document_pk, anchor);
CREATE INDEX items_key ON items(key) WHERE key IS NOT NULL;
CREATE INDEX items_item_id ON items(item_id);
CREATE TABLE item_paths(item_pk INTEGER NOT NULL REFERENCES items ON DELETE CASCADE, relation TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(item_pk, relation, path)) WITHOUT ROWID;
CREATE INDEX item_paths_path ON item_paths(path);
CREATE TABLE generation_items(generation INTEGER NOT NULL REFERENCES generations ON DELETE CASCADE, item_pk INTEGER NOT NULL REFERENCES items, base_status TEXT NOT NULL, effective_status TEXT NOT NULL, status_reason TEXT NOT NULL, basis_json TEXT NOT NULL, conflicts_json TEXT NOT NULL, links_json TEXT NOT NULL, PRIMARY KEY(generation,item_pk)) WITHOUT ROWID;
CREATE INDEX generation_items_item ON generation_items(item_pk);
CREATE VIRTUAL TABLE items_fts USING fts5(key_aliases, title, headings, body, ngram_title, ngram_body, tokenize="unicode61 remove_diacritics 2");
`,
  `
ALTER TABLE items ADD COLUMN token_count INTEGER;
ALTER TABLE items ADD COLUMN operations_json TEXT;
ALTER TABLE items ADD COLUMN declaration_json TEXT;
ALTER TABLE generations ADD COLUMN activated INTEGER NOT NULL DEFAULT 1;
ALTER TABLE generation_sources ADD COLUMN ref_origin TEXT;
ALTER TABLE generation_sources ADD COLUMN config_sha256 TEXT;
CREATE TABLE item_segments(segment_pk INTEGER PRIMARY KEY, item_pk INTEGER NOT NULL REFERENCES items ON DELETE CASCADE, ordinal INTEGER NOT NULL, segment_id TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL, token_count INTEGER NOT NULL, UNIQUE(item_pk, ordinal));
CREATE INDEX item_segments_id ON item_segments(segment_id);
CREATE VIRTUAL TABLE segments_fts USING fts5(key_aliases, title, headings, body, ngram_title, ngram_body, tokenize="unicode61 remove_diacritics 2");
CREATE TABLE generation_leases(lease_id TEXT PRIMARY KEY, generation INTEGER NOT NULL REFERENCES generations ON DELETE CASCADE, holder TEXT NOT NULL, acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL, expires_at TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX generation_leases_generation ON generation_leases(generation);
INSERT OR IGNORE INTO meta(key, value) VALUES('index_id', lower(hex(randomblob(16))));
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** 읽기만 하는 연결이 받아들이는 가장 낮은 스키마. 이보다 높고 최신보다 낮으면 기존 형식(v1) 요청만 처리한다. */
export const MIN_READABLE_SCHEMA = 1;

/** 현재 스키마의 테이블. 마이그레이션에 테이블을 추가하면 여기에도 적는다. */
export const REQUIRED_TABLES: readonly string[] = ['meta', 'index_runs', 'generations', 'generation_sources', 'documents', 'generation_documents', 'items', 'item_paths', 'generation_items', 'items_fts', 'item_segments', 'segments_fts', 'generation_leases'];

/** 마이그레이션 위치(0부터)별로 처음 생긴 테이블. 옛 스키마를 읽을 때 그 버전에 있어야 할 테이블만 확인한다. */
const TABLE_SINCE: Readonly<Record<string, number>> = { item_segments: 1, segments_fts: 1, generation_leases: 1 };

export function requiredTablesAt(version: number): string[] {
  return REQUIRED_TABLES.filter((table) => (TABLE_SINCE[table] ?? 0) < version);
}
