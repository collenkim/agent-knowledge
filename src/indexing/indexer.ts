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
import { assertLeaseRoom, checkHolder, checkTtl, insertLease, LEASE_TTL_SECONDS, leasedGenerations, systemClock, type Clock, type Lease } from './leases.js';
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
  /** false면 세대를 게시하되 기본 검색이 쓰는 활성 세대는 바꾸지 않는다. 작업 브랜치 같은 별도 기준을 색인할 때 쓴다. */
  activate?: boolean;
  /** 게시(또는 재사용)한 세대에 같은 트랜잭션에서 임대를 건다. 게시와 임대 사이에 다른 실행의 GC가 지우지 못하게 한다. */
  lease?: { holder: string; ttlSeconds?: number };
  /** 임대 만료 판정에 쓰는 시계. 시험에서 바꾼다. */
  clock?: Clock;
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
  /** `lease`를 요청했을 때만 있다. */
  lease?: Lease;
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
  activate: boolean;
  refOverrides: ReadonlyMap<string, string> | undefined;
  lease: { holder: string; ttlSeconds: number } | null;
  now: Date;
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

/** 원본 하나의 수집 규칙 해시. 세대 지문과 범위별 지문이 같은 값을 쓴다. */
export function sourceConfigHash(cfg: SourceConfig): string {
  const { rules, include, exclude, defaultKind, maxFileBytes } = cfg;
  return sha256(canonicalJson({ rules, include, exclude, defaultKind, maxFileBytes }));
}

function generationFingerprint(sources: readonly Collected[]): string {
  const entries = sources.map(({ cfg, commit }) => ({ sourceId: cfg.id, projectId: cfg.project, commit, configHash: sourceConfigHash(cfg) }));
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
  const insertItem = db.prepare('INSERT INTO items(document_pk, ordinal, item_id, key, anchor, unit, kind, title, heading_path_json, content, content_sha256, start_line, end_line, declared_status_raw, declared_status, basis_refs_json, rule_json, mandatory, aliases_json, applies_to_json, relations_json, token_count, operations_json, declaration_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertPath = db.prepare('INSERT INTO item_paths(item_pk, relation, path) VALUES(?,?,?)');
  const insertFts = db.prepare('INSERT INTO items_fts(rowid, key_aliases, title, headings, body, ngram_title, ngram_body) VALUES(?,?,?,?,?,?,?)');
  const insertSegment = db.prepare('INSERT INTO item_segments(item_pk, ordinal, segment_id, start_line, end_line, content, content_sha256, token_count) VALUES(?,?,?,?,?,?,?,?)');
  const insertSegmentFts = db.prepare('INSERT INTO segments_fts(rowid, key_aliases, title, headings, body, ngram_title, ngram_body) VALUES(?,?,?,?,?,?,?)');
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
          item.tokenCount, JSON.stringify(item.operations), JSON.stringify(item.declaration),
        ).lastInsertRowid,
      );
      for (const relation of ['code', 'test'] as const) {
        for (const target of item.relations[relation] ?? []) insertPath.run(itemPk, relation, target);
      }
      const columns = indexColumns(item);
      insertFts.run(itemPk, columns.key_aliases, columns.title, columns.headings, columns.body, columns.ngram_title, columns.ngram_body);
      for (const segment of item.segments) {
        const segmentPk = Number(insertSegment.run(itemPk, segment.ordinal, segment.segmentId, segment.startLine, segment.endLine, segment.content, segment.contentSha256, segment.tokenCount).lastInsertRowid);
        // 조각도 항목과 같은 키·제목 열을 가져야 조각 단위 순위에서 제목 일치가 사라지지 않는다
        const body = indexColumns({ ...item, content: segment.content });
        insertSegmentFts.run(segmentPk, columns.key_aliases, columns.title, columns.headings, body.body, columns.ngram_title, body.ngram_body);
      }
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

/**
 * 이번 실행의 세대, 활성 세대, 활성화했던 세대 중 최근 `retain`개, 유효한 임대가 걸린 세대만 남긴다.
 * 활성화하지 않고 임대도 없는 세대는 다음 실행까지만 남는다.
 * 쓰기 트랜잭션 안에서 부르므로 임대 획득과 엇갈리지 않는다.
 */
function collectGarbage(db: DatabaseSync, generation: number, retain: number, now: Date): void {
  const keep = new Set([generation, ...leasedGenerations(db, now)]);
  const active = readMeta(db, 'active_generation');
  if (active !== null) keep.add(active);
  // 활성화하지 않은 세대가 보존 개수를 차지하면, 그 기능을 쓰지 않는 호출자가 고정한 옛 활성 세대가 먼저 지워진다
  for (const recent of rows<{ generation: number }>(db, 'SELECT generation FROM generations WHERE activated = 1 ORDER BY generation DESC LIMIT ?', retain)) keep.add(recent.generation);
  const drop = db.prepare('DELETE FROM generations WHERE generation = ?');
  for (const candidate of rows<{ generation: number }>(db, 'SELECT generation FROM generations')) if (!keep.has(candidate.generation)) drop.run(candidate.generation);
  const unreferenced = 'SELECT document_pk FROM documents WHERE document_pk NOT IN (SELECT document_pk FROM generation_documents)';
  db.exec(`DELETE FROM items_fts WHERE rowid IN (SELECT item_pk FROM items WHERE document_pk IN (${unreferenced}))`);
  db.exec(`DELETE FROM segments_fts WHERE rowid IN (SELECT s.segment_pk FROM item_segments s JOIN items i ON i.item_pk = s.item_pk WHERE i.document_pk IN (${unreferenced}))`);
  db.exec(`DELETE FROM items WHERE document_pk IN (${unreferenced})`);
  db.exec(`DELETE FROM documents WHERE document_pk IN (${unreferenced})`);
}

/** 보존 수는 지문에 들어가지 않으므로, 줄인 설정과 만료된 임대는 게시 없이 끝나는 실행에서도 정리한다. */
function trimGenerations(db: DatabaseSync, generation: number, retain: number, now: Date): void {
  const { retained } = row<{ retained: number }>(db, 'SELECT count(*) AS retained FROM generations')!;
  const { leases } = row<{ leases: number }>(db, 'SELECT count(*) AS leases FROM generation_leases')!;
  if (retained <= retain && leases === 0) return;
  inWriteTransaction(db, () => collectGarbage(db, generation, retain, now));
}

function inWriteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function publish(db: DatabaseSync, plan: PublishPlan): Pick<IndexResult, 'generation' | 'documentCount' | 'itemCount' | 'sources'> {
  const { runId, active, fingerprint, retainGenerations, sources, hooks, activate, refOverrides, now } = plan;
  db.exec('BEGIN IMMEDIATE');
  if (readMeta(db, 'active_generation') !== active) {
    throw new KnowledgeError('index-conflict', '다른 색인 작업이 먼저 게시했습니다. 다시 실행해 주십시오', { expectedActive: active });
  }
  const generation = (readMeta(db, 'last_generation') ?? 0) + 1;
  const documents = sources.flatMap((source) => source.documents);
  const documentCount = documents.length;
  const itemCount = documents.reduce((sum, document) => sum + document.itemCount, 0);

  db.prepare('INSERT INTO generations(generation, published_at, run_id, parser_version, chunker_version, tokenizer_version, resolver_version, fingerprint, document_count, item_count, activated) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(generation, timestamp(), runId, PARSER_VERSION, CHUNKER_VERSION, TOKENIZER_VERSION, RESOLVER_VERSION, fingerprint, documentCount, itemCount, activate ? 1 : 0);

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

  const insertSource = db.prepare('INSERT INTO generation_sources(generation, source_id, project_id, requested_ref, commit_sha, document_count, skipped_json, ref_origin, config_sha256) VALUES(?,?,?,?,?,?,?,?,?)');
  const configHashes = new Map(sources.map((source) => [source.cfg.id, sourceConfigHash(source.cfg)]));
  for (const result of results) {
    const origin = refOverrides?.has(result.sourceId) ? 'override' : 'config';
    insertSource.run(generation, result.sourceId, result.projectId, result.requestedRef, result.commit, result.documentCount, JSON.stringify(result.skipped), origin, configHashes.get(result.sourceId)!);
  }

  hooks?.beforePublish?.(generation);
  if (activate) writeMeta(db, 'active_generation', generation);
  writeMeta(db, 'last_generation', generation);
  const lease = plan.lease === null ? undefined : insertLease(db, generation, plan.lease.holder, plan.lease.ttlSeconds, now);
  collectGarbage(db, generation, retainGenerations, now);
  db.exec('COMMIT');
  return { generation, documentCount, itemCount, sources: results, ...(lease === undefined ? {} : { lease }) };
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
  // 임대 요청의 잘못(too-many-leases 등)은 색인 실패가 아니라 요청 오류다. 감싸면 소비자가 reason으로 분기하지 못한다
  if (error instanceof KnowledgeError && ['index-failed', 'index-conflict', 'source-unavailable', 'invalid-request'].includes(error.code)) return error;
  const cause = { code: error instanceof KnowledgeError ? error.code : 'internal-error', message: error instanceof Error ? error.message : String(error) };
  return new KnowledgeError('index-failed', `색인에 실패했습니다: ${cause.message}`, { cause });
}

/** 활성 세대를 바꾸지 않는 실행은 보존된 어느 세대와 지문이 같아도 그 세대를 다시 쓴다. 기본 실행은 활성 세대만 비교한다. */
function reusableGeneration(db: DatabaseSync, fingerprint: string, active: number | null, activate: boolean): number | null {
  if (activate) {
    if (active === null) return null;
    return row<{ fingerprint: string }>(db, 'SELECT fingerprint FROM generations WHERE generation = ?', active)?.fingerprint === fingerprint ? active : null;
  }
  return row<{ generation: number }>(db, 'SELECT generation FROM generations WHERE fingerprint = ? ORDER BY generation DESC LIMIT 1', fingerprint)?.generation ?? null;
}

export function runIndex(options: RunIndexOptions): IndexResult {
  const { config, store, refOverrides, hooks } = options;
  const activate = options.activate ?? true;
  const clock = options.clock ?? systemClock;
  // 잘못된 임대 요청 때문에 색인을 다 만든 뒤 실패하지 않도록 먼저 검사한다
  const lease = options.lease === undefined ? null : { holder: checkHolder(options.lease.holder), ttlSeconds: checkTtl(options.lease.ttlSeconds ?? LEASE_TTL_SECONDS.default) };
  const { db } = store;
  // 임대 상한도 원본을 다 수집·해석하기 전에 본다. 실제 판정은 게시·재사용 트랜잭션 안의 insertLease가 다시 한다
  if (lease !== null) guardStore(() => assertLeaseRoom(db, clock()));
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
    if (lease === null) {
      const reusable = guardStore(() => reusableGeneration(db, fingerprint, active, activate));
      if (reusable !== null) {
        guardStore(() => trimGenerations(db, reusable, config.index.retainGenerations, clock()));
        const result = guardStore(() => unchangedResult(db, runId, reusable, collected));
        finishRun(db, runId, { status: 'unchanged', generation: reusable, stats: result });
        return result;
      }
    } else {
      // 재사용 판정·임대·GC·결과 읽기를 한 쓰기 트랜잭션에서 한다. 사이에 다른 실행의 GC가 그 세대를 지울 수 있고,
      // 임대를 커밋한 뒤 실패하면 호출자가 모르는 임대가 남는다
      const reused = guardStore(() =>
        inWriteTransaction(db, (): IndexResult | null => {
          // 바깥에서 읽은 활성 세대는 그사이 다른 실행이 바꿨을 수 있으므로 잠금 아래에서 다시 읽는다
          const found = reusableGeneration(db, fingerprint, readMeta(db, 'active_generation'), activate);
          if (found === null) return null;
          const now = clock();
          const leased = insertLease(db, found, lease.holder, lease.ttlSeconds, now);
          collectGarbage(db, found, config.index.retainGenerations, now);
          return { ...unchangedResult(db, runId, found, collected), lease: leased };
        }),
      );
      if (reused !== null) {
        finishRun(db, runId, { status: 'unchanged', generation: reused.generation, stats: reused });
        return reused;
      }
    }

    const sources = collected.map((source) => guardStore(() => prepareSource(db, source, report)));
    report({ stage: 'publish', message: activate ? '새 색인 세대를 게시합니다' : '활성 세대를 바꾸지 않고 새 색인 세대를 게시합니다' });
    const plan: PublishPlan = { runId, active, fingerprint, retainGenerations: config.index.retainGenerations, sources, hooks, activate, refOverrides, lease, now: clock() };
    const published = guardStore(() => publish(db, plan));
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
