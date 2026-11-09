import type { DatabaseSync } from 'node:sqlite';
import { KnowledgeError } from '../errors.js';
import type { BaseStatus, BasisRef, Diagnostic, Kind, Relations, SourceRule } from '../model.js';
import { buildDocumentItems, type BuiltDocument } from '../parsing/build-items.js';
import { indexColumns } from '../parsing/tokenize.js';
import { CHUNKER_VERSION, PARSER_VERSION, RESOLVER_VERSION, TOKENIZER_VERSION } from '../parsing/versions.js';
import { collectSource, decodeBlob, type Candidate, type CollectedSource, type SkippedPath } from '../sources/collect.js';
import { findRule, type SourceConfig, type SourcesConfig } from '../sources/config.js';
import { commitExists, readBlobs } from '../sources/git.js';
import { compareStrings } from '../util/compare.js';
import { canonicalJson, sha256 } from '../util/hash.js';
import { resolveGeneration, type GenerationItem, type SourceFacts } from './resolve.js';
import { guardStore, type Store } from './store.js';

export interface ProgressEvent {
  stage: 'collect' | 'parse' | 'publish' | 'diagnostic';
  message: string;
}

export interface IndexHooks {
  beforePublish?: (generation: number) => void;
}

export interface RunIndexOptions {
  config: SourcesConfig;
  store: Store;
  refOverrides?: ReadonlyMap<string, string>;
  hooks?: IndexHooks;
  /** 생략하면 진행 상황과 진단을 stderr에 쓴다. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface SourceIndexResult {
  sourceId: string;
  projectId: string;
  requestedRef: string;
  commit: string;
  documentCount: number;
  added: number;
  reused: number;
  removed: number;
  skipped: SkippedPath[];
}

export interface IndexResult {
  status: 'published' | 'unchanged';
  generation: number;
  runId: number;
  documentCount: number;
  itemCount: number;
  sources: SourceIndexResult[];
}

type Collected = CollectedSource & { cfg: SourceConfig };

interface PreparedDocument {
  candidate: Candidate;
  fingerprint: string;
  /** 재사용하는 행. null이면 built를 새로 넣는다. */
  documentPk: number | null;
  built: BuiltDocument | null;
  contentSha256: string;
  itemCount: number;
}

interface PreparedSource extends Collected {
  documents: PreparedDocument[];
  skipped: SkippedPath[];
  facts: SourceFacts;
}

interface PublishPlan {
  runId: number;
  active: number | null;
  fingerprint: string;
  retainGenerations: number;
  sources: PreparedSource[];
  hooks: IndexHooks | undefined;
}

function timestamp(): string {
  return new Date().toISOString();
}

function row<T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

function rows<T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function readMeta(db: DatabaseSync, key: string): number | null {
  const found = row<{ value: string }>(db, 'SELECT value FROM meta WHERE key = ?', key);
  return found ? Number(found.value) : null;
}

function writeMeta(db: DatabaseSync, key: string, value: number): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function generationFingerprint(sources: readonly Collected[]): string {
  const entries = sources.map(({ cfg, commit }) => {
    const { rules, include, exclude, defaultKind, maxFileBytes } = cfg;
    return { sourceId: cfg.id, projectId: cfg.project, commit, configHash: sha256(canonicalJson({ rules, include, exclude, defaultKind, maxFileBytes })) };
  });
  return sha256(canonicalJson({ sources: entries, versions: [PARSER_VERSION, CHUNKER_VERSION, TOKENIZER_VERSION, RESOLVER_VERSION] }));
}

function parseFingerprint(cfg: SourceConfig, rule: SourceRule | null): string {
  return sha256(canonicalJson([PARSER_VERSION, CHUNKER_VERSION, TOKENIZER_VERSION, cfg.project, rule, cfg.defaultKind]));
}

function prepareSource(db: DatabaseSync, source: Collected, report: (event: ProgressEvent) => void): PreparedSource {
  const { cfg } = source;
  report({ stage: 'parse', message: `문서를 분석합니다: ${cfg.id}` });
  const findDocument = db.prepare('SELECT document_pk AS pk, diagnostics_json AS diagnostics FROM documents WHERE source_id = ? AND path = ? AND blob_sha = ? AND parse_fingerprint = ?');
  const findBasis = db.prepare('SELECT basis_refs_json AS refs FROM items WHERE document_pk = ?');

  const planned = source.candidates.map((candidate) => {
    const rule = findRule(cfg.rules, candidate.path);
    const fingerprint = parseFingerprint(cfg, rule);
    const existing = findDocument.get(cfg.id, candidate.path, candidate.sha, fingerprint) as unknown as { pk: number; diagnostics: string } | undefined;
    return { candidate, rule, fingerprint, existing };
  });
  const blobs = readBlobs(cfg.path, planned.filter((plan) => !plan.existing).map((plan) => plan.candidate));

  const documents: PreparedDocument[] = [];
  const skipped = [...source.skipped];
  const commitRefs = new Set<string>();
  const addCommitRefs = (refs: readonly BasisRef[]): void => {
    for (const ref of refs) if (ref.kind === 'commit') commitRefs.add(ref.value);
  };
  const reportDiagnostics = (path: string, diagnostics: readonly Diagnostic[]): void => {
    for (const { code } of diagnostics) report({ stage: 'diagnostic', message: `${cfg.id}:${path} ${code}` });
  };

  for (const { candidate, rule, fingerprint, existing } of planned) {
    if (existing) {
      const basis = findBasis.all(existing.pk) as unknown as { refs: string }[];
      for (const { refs } of basis) addCommitRefs(JSON.parse(refs) as BasisRef[]);
      reportDiagnostics(candidate.path, JSON.parse(existing.diagnostics) as Diagnostic[]);
      documents.push({ candidate, fingerprint, documentPk: existing.pk, built: null, contentSha256: '', itemCount: basis.length });
      continue;
    }
    const bytes = blobs.get(candidate.sha)!;
    const decoded = decodeBlob(bytes);
    if ('reason' in decoded) {
      skipped.push({ path: candidate.path, reason: decoded.reason });
      continue;
    }
    const built = buildDocumentItems({ sourceId: cfg.id, projectId: cfg.project, path: candidate.path, text: decoded.text, rule, defaultKind: cfg.defaultKind });
    for (const item of built.items) addCommitRefs(item.basisRefs);
    reportDiagnostics(candidate.path, built.diagnostics);
    documents.push({ candidate, fingerprint, documentPk: null, built, contentSha256: sha256(bytes), itemCount: built.items.length });
  }

  skipped.sort((a, b) => compareStrings(a.path, b.path));
  // 커밋 존재 확인은 git 호출이므로 쓰기 트랜잭션을 열기 전에 끝낸다
  const existingCommits = new Set([...commitRefs].filter((sha) => commitExists(cfg.path, sha)));
  return { ...source, documents, skipped, facts: { tracked: source.tracked, existingCommits } };
}

function insertDocuments(db: DatabaseSync, source: PreparedSource, generation: number): number[] {
  const insertDocument = db.prepare('INSERT INTO documents(source_id, project_id, path, blob_sha, content_sha256, byte_size, line_count, parse_fingerprint, title, diagnostics_json, first_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const insertItem = db.prepare('INSERT INTO items(document_pk, ordinal, item_id, key, anchor, unit, kind, title, heading_path_json, content, content_sha256, start_line, end_line, declared_status_raw, declared_status, basis_refs_json, rule_json, mandatory, aliases_json, applies_to_json, relations_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertPath = db.prepare('INSERT INTO item_paths(item_pk, relation, path) VALUES(?,?,?)');
  const insertFts = db.prepare('INSERT INTO items_fts(rowid, key_aliases, title, headings, body, ngram_title, ngram_body) VALUES(?,?,?,?,?,?,?)');
  const { cfg } = source;

  return source.documents.map(({ candidate, fingerprint, documentPk, built, contentSha256 }) => {
    if (documentPk !== null) return documentPk;
    const { path, sha, size } = candidate;
    const newPk = Number(insertDocument.run(cfg.id, cfg.project, path, sha, contentSha256, size, built!.lineCount, fingerprint, built!.title, JSON.stringify(built!.diagnostics), generation).lastInsertRowid);
    for (const item of built!.items) {
      const itemPk = Number(
        insertItem.run(
          newPk, item.ordinal, item.itemId, item.key, item.anchor, item.unit, item.kind, item.title, JSON.stringify(item.headingPath), item.content, item.contentSha256, item.startLine, item.endLine,
          item.declaredStatusRaw, item.declaredStatus, JSON.stringify(item.basisRefs), JSON.stringify(item.rule), item.mandatory ? 1 : 0, JSON.stringify(item.aliases), JSON.stringify(item.appliesTo), JSON.stringify(item.relations),
        ).lastInsertRowid,
      );
      for (const relation of ['code', 'test'] as const) {
        for (const target of item.relations[relation] ?? []) insertPath.run(itemPk, relation, target);
      }
      const columns = indexColumns(item);
      insertFts.run(itemPk, columns.key_aliases, columns.title, columns.headings, columns.body, columns.ngram_title, columns.ngram_body);
    }
    return newPk;
  });
}

interface StoredItemRow {
  itemPk: number;
  itemId: string;
  documentPk: number;
  sourceId: string;
  projectId: string;
  path: string;
  ordinal: number;
  key: string | null;
  anchor: string;
  kind: Kind;
  declaredStatus: BaseStatus | null;
  declaredStatusRaw: string | null;
  basisRefsJson: string;
  ruleJson: string;
  relationsJson: string;
}

function loadGenerationItems(db: DatabaseSync, generation: number): GenerationItem[] {
  const stored = rows<StoredItemRow>(
    db,
    `SELECT i.item_pk AS itemPk, i.item_id AS itemId, i.document_pk AS documentPk, d.source_id AS sourceId, d.project_id AS projectId, d.path AS path,
            i.ordinal AS ordinal, i.key AS key, i.anchor AS anchor, i.kind AS kind, i.declared_status AS declaredStatus, i.declared_status_raw AS declaredStatusRaw,
            i.basis_refs_json AS basisRefsJson, i.rule_json AS ruleJson, i.relations_json AS relationsJson
     FROM generation_documents g JOIN documents d ON d.document_pk = g.document_pk JOIN items i ON i.document_pk = d.document_pk
     WHERE g.generation = ?`,
    generation,
  );
  return stored
    .map(({ basisRefsJson, ruleJson, relationsJson, ...item }) => ({
      ...item,
      basisRefs: JSON.parse(basisRefsJson) as BasisRef[],
      rule: JSON.parse(ruleJson) as SourceRule | null,
      relations: JSON.parse(relationsJson) as Relations,
    }))
    .sort((a, b) => compareStrings(a.itemId, b.itemId));
}

function collectGarbage(db: DatabaseSync, generation: number, retain: number): void {
  db.prepare('DELETE FROM generations WHERE generation <> ? AND generation NOT IN (SELECT generation FROM generations ORDER BY generation DESC LIMIT ?)').run(generation, retain);
  const unreferenced = 'SELECT document_pk FROM documents WHERE document_pk NOT IN (SELECT document_pk FROM generation_documents)';
  db.exec(`DELETE FROM items_fts WHERE rowid IN (SELECT item_pk FROM items WHERE document_pk IN (${unreferenced}))`);
  db.exec(`DELETE FROM items WHERE document_pk IN (${unreferenced})`);
  db.exec(`DELETE FROM documents WHERE document_pk IN (${unreferenced})`);
}

/** 보존 수는 지문에 들어가지 않으므로, 줄인 설정은 게시 없이 끝나는 실행에서도 적용해야 한다. */
function trimGenerations(db: DatabaseSync, generation: number, retain: number): void {
  const { retained } = row<{ retained: number }>(db, 'SELECT count(*) AS retained FROM generations')!;
  if (retained <= retain) return;
  db.exec('BEGIN IMMEDIATE');
  collectGarbage(db, generation, retain);
  db.exec('COMMIT');
}

function publish(db: DatabaseSync, plan: PublishPlan): Pick<IndexResult, 'generation' | 'documentCount' | 'itemCount' | 'sources'> {
  const { runId, active, fingerprint, retainGenerations, sources, hooks } = plan;
  db.exec('BEGIN IMMEDIATE');
  if (readMeta(db, 'active_generation') !== active) {
    throw new KnowledgeError('index-conflict', '다른 색인 작업이 먼저 게시했습니다. 다시 실행해 주십시오', { expectedActive: active });
  }
  const generation = (readMeta(db, 'last_generation') ?? 0) + 1;
  const documents = sources.flatMap((source) => source.documents);
  const documentCount = documents.length;
  const itemCount = documents.reduce((sum, document) => sum + document.itemCount, 0);

  db.prepare('INSERT INTO generations(generation, published_at, run_id, parser_version, chunker_version, tokenizer_version, resolver_version, fingerprint, document_count, item_count) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(generation, timestamp(), runId, PARSER_VERSION, CHUNKER_VERSION, TOKENIZER_VERSION, RESOLVER_VERSION, fingerprint, documentCount, itemCount);

  const previous = active === null ? [] : rows<{ pk: number; sourceId: string }>(db, 'SELECT g.document_pk AS pk, d.source_id AS sourceId FROM generation_documents g JOIN documents d ON d.document_pk = g.document_pk WHERE g.generation = ?', active);
  const linkDocument = db.prepare('INSERT INTO generation_documents(generation, document_pk) VALUES(?,?)');
  const results = sources.map((source): SourceIndexResult => {
    const current = insertDocuments(db, source, generation);
    for (const documentPk of current) linkDocument.run(generation, documentPk);
    const before = new Set(previous.filter((document) => document.sourceId === source.cfg.id).map((document) => document.pk));
    const reused = current.filter((documentPk) => before.has(documentPk)).length;
    return {
      sourceId: source.cfg.id,
      projectId: source.cfg.project,
      requestedRef: source.requestedRef,
      commit: source.commit,
      documentCount: current.length,
      added: current.length - reused,
      reused,
      removed: before.size - reused,
      skipped: source.skipped,
    };
  });

  const facts = new Map(sources.map((source) => [source.cfg.id, source.facts]));
  const insertStatus = db.prepare('INSERT INTO generation_items(generation, item_pk, base_status, effective_status, status_reason, basis_json, conflicts_json, links_json) VALUES(?,?,?,?,?,?,?,?)');
  for (const item of resolveGeneration(loadGenerationItems(db, generation), facts)) {
    insertStatus.run(generation, item.itemPk, item.baseStatus, item.effectiveStatus, item.reason, JSON.stringify(item.basis), JSON.stringify(item.conflicts), JSON.stringify(item.links));
  }

  const insertSource = db.prepare('INSERT INTO generation_sources(generation, source_id, project_id, requested_ref, commit_sha, document_count, skipped_json) VALUES(?,?,?,?,?,?,?)');
  for (const result of results) insertSource.run(generation, result.sourceId, result.projectId, result.requestedRef, result.commit, result.documentCount, JSON.stringify(result.skipped));

  hooks?.beforePublish?.(generation);
  writeMeta(db, 'active_generation', generation);
  writeMeta(db, 'last_generation', generation);
  collectGarbage(db, generation, retainGenerations);
  db.exec('COMMIT');
  return { generation, documentCount, itemCount, sources: results };
}

function unchangedResult(db: DatabaseSync, runId: number, generation: number, sources: readonly Collected[]): IndexResult {
  const stored = new Map(rows<{ sourceId: string; documentCount: number; skipped: string }>(db, 'SELECT source_id AS sourceId, document_count AS documentCount, skipped_json AS skipped FROM generation_sources WHERE generation = ?', generation).map((source) => [source.sourceId, source]));
  const counts = row<{ documentCount: number; itemCount: number }>(db, 'SELECT document_count AS documentCount, item_count AS itemCount FROM generations WHERE generation = ?', generation)!;
  return {
    status: 'unchanged',
    generation,
    runId,
    ...counts,
    sources: sources.map(({ cfg, commit, requestedRef }) => {
      const source = stored.get(cfg.id)!;
      return { sourceId: cfg.id, projectId: cfg.project, requestedRef, commit, documentCount: source.documentCount, added: 0, reused: source.documentCount, removed: 0, skipped: JSON.parse(source.skipped) as SkippedPath[] };
    }),
  };
}

type RunOutcome = { status: 'published' | 'unchanged'; generation: number; stats: IndexResult } | { status: 'failed'; error: KnowledgeError };

/** 실행 기록 실패가 색인 결과나 원래 오류를 바꾸면 안 되므로 여기서 삼키고 stderr로만 알린다. */
function finishRun(db: DatabaseSync, runId: number, outcome: RunOutcome): void {
  try {
    const failure = outcome.status === 'failed' ? outcome.error : null;
    guardStore(() =>
      db.prepare('UPDATE index_runs SET finished_at = ?, status = ?, generation = ?, error_code = ?, error_message = ?, stats_json = ? WHERE run_id = ?')
        .run(timestamp(), outcome.status, outcome.status === 'failed' ? null : outcome.generation, failure?.code ?? null, failure?.message ?? null, outcome.status === 'failed' ? null : JSON.stringify(outcome.stats), runId),
    );
  } catch (error) {
    process.stderr.write(`색인 실행 기록을 갱신하지 못했습니다: ${(error as Error).message}\n`);
  }
}

function toIndexError(error: unknown): KnowledgeError {
  if (error instanceof KnowledgeError && ['index-failed', 'index-conflict', 'source-unavailable'].includes(error.code)) return error;
  const cause = { code: error instanceof KnowledgeError ? error.code : 'internal-error', message: error instanceof Error ? error.message : String(error) };
  return new KnowledgeError('index-failed', `색인에 실패했습니다: ${cause.message}`, { cause });
}

export function runIndex(options: RunIndexOptions): IndexResult {
  const { config, store, refOverrides, hooks } = options;
  const { db } = store;
  const report = options.onProgress ?? ((event: ProgressEvent) => void process.stderr.write(`${event.message}\n`));
  const runId = guardStore(() => Number(db.prepare("INSERT INTO index_runs(started_at, status) VALUES(?, 'running')").run(timestamp()).lastInsertRowid));

  try {
    for (const sourceId of refOverrides?.keys() ?? []) {
      // 오타 난 재정의를 무시하면 의도와 다른 커밋을 게시하게 된다
      if (!config.sources.some((source) => source.id === sourceId)) throw new KnowledgeError('source-unavailable', `설정에 없는 원본입니다: ${sourceId}`, { reason: 'unknown-source', sourceId });
    }
    const collected = [...config.sources]
      .sort((a, b) => compareStrings(a.id, b.id))
      .map((cfg): Collected => {
        report({ stage: 'collect', message: `원본을 수집합니다: ${cfg.id}` });
        const source = collectSource(cfg, refOverrides?.get(cfg.id));
        if (source.candidates.length === 0) report({ stage: 'diagnostic', message: `${cfg.id} no-matching-documents: include와 일치하는 추적 문서가 없습니다.` });
        return { cfg, ...source };
      });

    const fingerprint = generationFingerprint(collected);
    const active = guardStore(() => readMeta(db, 'active_generation'));
    const activeFingerprint = active === null ? undefined : guardStore(() => row<{ fingerprint: string }>(db, 'SELECT fingerprint FROM generations WHERE generation = ?', active)?.fingerprint);
    if (active !== null && activeFingerprint === fingerprint) {
      guardStore(() => trimGenerations(db, active, config.index.retainGenerations));
      const result = guardStore(() => unchangedResult(db, runId, active, collected));
      finishRun(db, runId, { status: 'unchanged', generation: active, stats: result });
      return result;
    }

    const sources = collected.map((source) => guardStore(() => prepareSource(db, source, report)));
    report({ stage: 'publish', message: '새 색인 세대를 게시합니다' });
    const published = guardStore(() => publish(db, { runId, active, fingerprint, retainGenerations: config.index.retainGenerations, sources, hooks }));
    const result: IndexResult = { status: 'published', runId, ...published };
    finishRun(db, runId, { status: 'published', generation: result.generation, stats: result });
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        process.stderr.write(`색인 트랜잭션을 되돌리지 못했습니다: ${(rollbackError as Error).message}\n`);
      }
    }
    const failure = toIndexError(error);
    finishRun(db, runId, { status: 'failed', error: failure });
    throw failure;
  }
}
