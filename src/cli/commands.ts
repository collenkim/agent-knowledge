import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { EXIT_CODES, KnowledgeError } from '../errors.js';
import { runEvaluation } from '../evaluation/runner.js';
import { openKnowledgeBase, type KnowledgeBaseOptions } from '../index.js';
import { runIndex, sourceConfigHash, type IndexResult } from '../indexing/indexer.js';
import { acquireLease, listLeases, readIndexId, releaseLease, renewLease, type Lease, type LeaseView } from '../indexing/leases.js';
import { SCHEMA_VERSION } from '../indexing/schema.js';
import { openExistingForWrite, openForRead, openForWrite, type Store } from '../indexing/store.js';
import { loadRetrievalConfig } from '../profiles/config.js';
import { capabilitiesOf } from '../retrieval/capabilities.js';
import { getAny } from '../retrieval/get.js';
import { searchAny } from '../retrieval/searcher.js';
import { verifyReferences } from '../retrieval/verify.js';
import { loadSourcesConfig, type SourcesConfig } from '../sources/config.js';
import { resolveCommit } from '../sources/git.js';
import { validateSources } from '../sources/validate.js';
import { compareStrings } from '../util/compare.js';
import {
  getRequestOf,
  HELP,
  knownCommand,
  list,
  parseCommandLine,
  parseInteger,
  parsePairs,
  required,
  responseVersionFlag,
  searchRequestOf,
  single,
  verifyRequestOf,
  type Command,
  type LeaseAction,
  type Values,
} from './args.js';
import { asKnowledgeError, errorBody, errorDocument, progressWriter, writeDiagnostic, writeDocument, type Progress } from './output.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SHOWN_DIAGNOSTICS = 50;
const SHOWN_RUNS = 5;
const NO_RESULTS_EXIT = 3;

interface Invocation {
  values: Values;
  paths: Required<Pick<KnowledgeBaseOptions, 'configPath' | 'retrievalConfigPath'>> & Pick<KnowledgeBaseOptions, 'dbPath'>;
  pretty: boolean;
  progress: Progress;
}

function fromEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

function pathsOf(values: Values): Invocation['paths'] {
  return {
    configPath: single(values, 'config') ?? fromEnv('AGENT_KNOWLEDGE_CONFIG') ?? join(PACKAGE_ROOT, 'config', 'sources.yaml'),
    retrievalConfigPath: single(values, 'retrieval-config') ?? fromEnv('AGENT_KNOWLEDGE_RETRIEVAL_CONFIG') ?? join(PACKAGE_ROOT, 'config', 'retrieval.yaml'),
    dbPath: single(values, 'db') ?? fromEnv('AGENT_KNOWLEDGE_DB'),
  };
}

function runValidate({ paths, pretty, progress }: Invocation): number {
  const report = validateSources(loadSourcesConfig(paths.configPath));
  for (const source of report.sources) {
    progress(`원본을 검사했습니다: ${source.id} (문서 ${source.matchedDocuments}개)`);
    for (const issue of [...source.errors, ...source.warnings]) writeDiagnostic(`${source.id} ${issue.code}: ${issue.message}`);
  }

  let retrieval: { ok: boolean; error?: ReturnType<typeof errorBody> } = { ok: true };
  try {
    loadRetrievalConfig(paths.retrievalConfigPath);
  } catch (error) {
    if (!(error instanceof KnowledgeError)) throw error;
    retrieval = { ok: false, error: errorBody(error) };
    writeDiagnostic(`${error.code}: ${error.message}`);
  }

  const ok = report.ok && retrieval.ok;
  writeDocument(
    {
      schema: 'agent-knowledge.validate',
      schemaVersion: 1,
      ok,
      status: ok ? 'valid' : 'invalid',
      sources: report.sources,
      retrieval,
      ...(ok ? {} : { error: { code: 'config-invalid', message: '설정 검사를 통과하지 못했습니다', detail: {} } }),
    },
    pretty,
  );
  return ok ? 0 : EXIT_CODES['config-invalid'];
}

function usage(message: string, detail: Record<string, unknown>): KnowledgeError {
  return new KnowledgeError('usage', message, detail);
}

function leaseOptionOf(values: Values, responseVersion: 1 | 2): { holder: string; ttlSeconds?: number } | undefined {
  const holder = single(values, 'lease-holder');
  const ttl = single(values, 'lease-ttl');
  if (holder === undefined && ttl === undefined) return undefined;
  // 임대 ID는 형식 2 출력에만 실리므로, 형식 1로 임대를 걸면 호출자가 풀 방법이 없다
  if (responseVersion !== 2) throw usage('--lease-holder와 --lease-ttl은 --response-version 2와 함께 써야 합니다', { flags: ['lease-holder', 'lease-ttl'].filter((flag) => values[flag] !== undefined) });
  if (holder === undefined) throw usage('--lease-ttl에는 --lease-holder가 필요합니다', { flag: 'lease-holder' });
  return { holder, ...(ttl === undefined ? {} : { ttlSeconds: parseInteger(ttl, 'lease-ttl') }) };
}

/** 형식 2의 index 출력. 키를 명시해 내부 결과에 필드가 늘어도 출력 계약이 따라 바뀌지 않게 한다. */
function indexDocumentV2(store: Store, config: SourcesConfig, refOverrides: ReadonlyMap<string, string>, result: IndexResult): Record<string, unknown> {
  const { db } = store;
  const generation = db.prepare('SELECT activated, fingerprint FROM generations WHERE generation = ?').get(result.generation) as unknown as { activated: number; fingerprint: string };
  const active = db.prepare("SELECT value FROM meta WHERE key = 'active_generation'").get() as unknown as { value: string } | undefined;
  return {
    schema: 'agent-knowledge.index',
    schemaVersion: 2,
    ok: true,
    status: result.status,
    generation: result.generation,
    runId: result.runId,
    documentCount: result.documentCount,
    itemCount: result.itemCount,
    sources: result.sources.map((source) => ({
      ...source,
      refOrigin: refOverrides.has(source.sourceId) ? 'override' : 'config',
      configSha256: sourceConfigHash(config.sources.find((candidate) => candidate.id === source.sourceId)!),
    })),
    commits: Object.fromEntries(result.sources.map((source) => [source.sourceId, source.commit])),
    indexId: readIndexId(db),
    fingerprint: generation.fingerprint,
    activated: generation.activated === 1,
    activeGeneration: active === undefined ? null : Number(active.value),
    lease: result.lease ?? null,
  };
}

function runIndexCommand({ values, paths, pretty, progress }: Invocation): number {
  const responseVersion = responseVersionFlag(values) ?? 1;
  const lease = leaseOptionOf(values, responseVersion);
  const activate = values['no-activate'] !== true;
  const config = loadSourcesConfig(paths.configPath);
  const refOverrides = parsePairs(values, 'ref');
  const store = openForWrite(resolve(paths.dbPath ?? config.database.path));
  try {
    const result = runIndex({ config, store, refOverrides, activate, ...(lease === undefined ? {} : { lease }), onProgress: (event) => (event.stage === 'diagnostic' ? writeDiagnostic : progress)(event.message) });
    const commits = Object.fromEntries(result.sources.map((source) => [source.sourceId, source.commit]));
    if (result.status === 'unchanged') progress(`변경이 없어 세대 ${result.generation}을(를) 유지합니다`);
    else progress(activate ? `색인 세대 ${result.generation}을(를) 게시했습니다` : `색인 세대 ${result.generation}을(를) 게시했습니다. 활성 세대는 바꾸지 않았습니다`);
    writeDocument(responseVersion === 2 ? indexDocumentV2(store, config, refOverrides, result) : { schema: 'agent-knowledge.index', schemaVersion: 1, ok: true, ...result, commits }, pretty);
    return 0;
  } finally {
    store.close();
  }
}

interface GenerationSourceRow {
  sourceId: string;
  projectId: string;
  commit: string;
  requestedRef: string;
  documentCount: number;
}

interface StatusSnapshot {
  activeGeneration: number;
  retainedGenerations: Record<string, unknown>[];
  sources: GenerationSourceRow[];
  counts: { byStatus: Record<string, number>; byKind: Record<string, number> };
  runs: Record<string, unknown>[];
  lastFailure: Record<string, unknown> | null;
  diagnostics: { sourceId: string; path: string; code: string; message: string }[];
}

function rowsOf<T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function countsBy(db: DatabaseSync, column: string, generation: number): Record<string, number> {
  const rows = rowsOf<{ name: string; count: number }>(db, `SELECT ${column} AS name, count(*) AS count FROM generation_items g JOIN items i ON i.item_pk = g.item_pk WHERE g.generation = ? GROUP BY ${column} ORDER BY ${column}`, generation);
  return Object.fromEntries(rows.map((row) => [row.name, row.count]));
}

const RUN_COLUMNS = 'run_id AS runId, started_at AS startedAt, finished_at AS finishedAt, status, generation, error_code AS errorCode';

function readStatus(db: DatabaseSync): StatusSnapshot {
  const active = rowsOf<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'active_generation'")[0];
  if (active === undefined) throw new KnowledgeError('index-missing', '게시된 색인이 없습니다', { reason: 'no-generation' });
  const activeGeneration = Number(active.value);

  const diagnostics = rowsOf<{ sourceId: string; path: string; diagnostics: string }>(
    db,
    `SELECT d.source_id AS sourceId, d.path AS path, d.diagnostics_json AS diagnostics FROM generation_documents g JOIN documents d ON d.document_pk = g.document_pk
     WHERE g.generation = ? AND d.diagnostics_json <> '[]'`,
    activeGeneration,
  )
    .sort((a, b) => compareStrings(a.sourceId, b.sourceId) || compareStrings(a.path, b.path))
    .flatMap(({ sourceId, path, diagnostics: json }) => (JSON.parse(json) as { code: string; message: string }[]).map(({ code, message }) => ({ sourceId, path, code, message })));

  return {
    activeGeneration,
    retainedGenerations: rowsOf(db, 'SELECT generation, published_at AS publishedAt, document_count AS documentCount, item_count AS itemCount FROM generations ORDER BY generation DESC'),
    sources: rowsOf(db, 'SELECT source_id AS sourceId, project_id AS projectId, commit_sha AS "commit", requested_ref AS requestedRef, document_count AS documentCount FROM generation_sources WHERE generation = ? ORDER BY source_id', activeGeneration),
    counts: { byStatus: countsBy(db, 'g.effective_status', activeGeneration), byKind: countsBy(db, 'i.kind', activeGeneration) },
    runs: rowsOf(db, `SELECT ${RUN_COLUMNS} FROM index_runs ORDER BY run_id DESC LIMIT ?`, SHOWN_RUNS),
    lastFailure: rowsOf<Record<string, unknown>>(db, `SELECT ${RUN_COLUMNS}, error_message AS errorMessage FROM index_runs WHERE status = 'failed' ORDER BY run_id DESC LIMIT 1`)[0] ?? null,
    diagnostics,
  };
}

/** 설정이 없거나 ref를 풀 수 없으면 최신 여부를 알 수 없으므로 false가 아니라 null이다. */
function isUpToDate(config: SourcesConfig | null, sourceId: string, commit: string): boolean | null {
  const source = config?.sources.find((candidate) => candidate.id === sourceId);
  if (!source) return null;
  try {
    return resolveCommit(source.path, source.ref) === commit;
  } catch (error) {
    if (error instanceof KnowledgeError && error.code === 'source-unavailable') return null;
    throw error;
  }
}

interface StatusExtras {
  indexId: string | null;
  databaseSchemaVersion: number;
  generations: { generation: number; activated: boolean; fingerprint: string; parserVersion: string; chunkerVersion: string; liveLeases: number }[];
  leases: { live: number; expired: number };
}

/** 읽기 전용이므로 만료된 임대를 지우지 않고 수만 센다. 지우는 일은 GC가 쓰기 트랜잭션에서 한다. */
function readStatusExtras(db: DatabaseSync, schemaVersion: number, now: string): StatusExtras {
  const generations = rowsOf<{ generation: number; activated: number; fingerprint: string; parserVersion: string; chunkerVersion: string; liveLeases: number }>(
    db,
    `SELECT g.generation AS generation, g.activated AS activated, g.fingerprint AS fingerprint, g.parser_version AS parserVersion, g.chunker_version AS chunkerVersion,
       (SELECT count(*) FROM generation_leases l WHERE l.generation = g.generation AND l.expires_at > ?) AS liveLeases
     FROM generations g ORDER BY g.generation DESC`,
    now,
  );
  const leases = rowsOf<{ live: number; expired: number }>(db, 'SELECT coalesce(sum(expires_at > ?), 0) AS live, coalesce(sum(expires_at <= ?), 0) AS expired FROM generation_leases', now, now)[0]!;
  return {
    indexId: readIndexId(db),
    databaseSchemaVersion: schemaVersion,
    generations: generations.map((row) => ({ ...row, activated: row.activated === 1 })),
    leases,
  };
}

function schemaUpgradeRequired(store: Store): KnowledgeError {
  return new KnowledgeError('index-missing', '이 요청에는 새 색인 스키마가 필요합니다. index를 한 번 실행해 주십시오', { reason: 'schema-upgrade-required', version: store.schemaVersion, required: SCHEMA_VERSION });
}

function runStatus({ values, paths, pretty }: Invocation): number {
  const responseVersion = responseVersionFlag(values) ?? 1;
  const kb = openKnowledgeBase(paths);
  const store = openForRead(kb.dbPath);
  let snapshot: StatusSnapshot;
  let extras: StatusExtras | null = null;
  try {
    if (responseVersion === 2 && store.schemaVersion < SCHEMA_VERSION) throw schemaUpgradeRequired(store);
    const now = new Date().toISOString();
    [snapshot, extras] = store.read((db) => [readStatus(db), responseVersion === 2 ? readStatusExtras(db, store.schemaVersion, now) : null] as const);
  } finally {
    store.close();
  }

  const { diagnostics, sources, ...rest } = snapshot;
  const indexedIds = new Set(sources.map((source) => source.sourceId));
  // git 호출이 읽기 트랜잭션을 붙잡지 않도록 저장소를 닫은 뒤 확인한다
  const reported = [
    ...sources.map((source) => ({ ...source, upToDate: isUpToDate(kb.sources, source.sourceId, source.commit) })),
    ...(kb.sources?.sources ?? []).filter((source) => !indexedIds.has(source.id)).map((source) => ({ sourceId: source.id, projectId: source.project, commit: null, requestedRef: source.ref, documentCount: 0, upToDate: false })),
  ].sort((a, b) => compareStrings(a.sourceId, b.sourceId));

  writeDocument(
    {
      schema: 'agent-knowledge.status',
      schemaVersion: responseVersion,
      ok: true,
      status: 'ok',
      ...rest,
      sources: reported,
      vector: { implemented: false, state: 'not-implemented' },
      diagnostics: diagnostics.slice(0, SHOWN_DIAGNOSTICS),
      diagnosticsTotal: diagnostics.length,
      ...(extras ?? {}),
    },
    pretty,
  );
  return 0;
}

function runSearch({ values, paths, pretty }: Invocation): number {
  const request = searchRequestOf(values);
  const response = searchAny(openKnowledgeBase(paths), request);
  writeDocument(response, pretty);
  return response.status === 'no-results' ? NO_RESULTS_EXIT : 0;
}

function runGet({ values, paths, pretty }: Invocation): number {
  const request = getRequestOf(values);
  writeDocument(getAny(openKnowledgeBase(paths), request), pretty);
  return 0;
}

/** 확인 결과에 문제가 있어도 0이다. 판정은 문서의 results와 summary로 읽는다. 참조 확인일 뿐 승인이나 검증이 아니다. */
function runVerify({ values, paths, pretty }: Invocation): number {
  // search·get처럼 요청 옵션 오류를 설정 오류보다 먼저 알린다
  const request = verifyRequestOf(values);
  writeDocument(verifyReferences(openKnowledgeBase(paths), request), pretty);
  return 0;
}

function runCapabilities({ paths, pretty }: Invocation): number {
  writeDocument(capabilitiesOf(loadRetrievalConfig(paths.retrievalConfigPath)), pretty);
  return 0;
}

function optionalInteger(values: Values, flag: string): number | undefined {
  const raw = single(values, flag);
  return raw === undefined ? undefined : parseInteger(raw, flag);
}

interface LeaseOutcome {
  lease?: Lease;
  released?: boolean;
  leaseId?: string;
  leases?: LeaseView[];
}

function leaseAction(action: LeaseAction, values: Values, dbPath: string): { indexId: string | null } & LeaseOutcome {
  if (action === 'list') {
    const store = openForRead(dbPath);
    try {
      if (store.schemaVersion < SCHEMA_VERSION) throw schemaUpgradeRequired(store);
      const now = new Date();
      return store.read((db) => ({ indexId: readIndexId(db), leases: listLeases(db, single(values, 'holder'), now) }));
    } finally {
      store.close();
    }
  }
  const store = openExistingForWrite(dbPath);
  try {
    const indexId = readIndexId(store.db);
    const ttlSeconds = optionalInteger(values, 'ttl');
    if (action === 'acquire') {
      const generation = optionalInteger(values, 'generation');
      const expected = single(values, 'index-id');
      const lease = acquireLease(store, { holder: required(values, 'holder'), ...(generation === undefined ? {} : { generation }), ...(ttlSeconds === undefined ? {} : { ttlSeconds }), ...(expected === undefined ? {} : { indexId: expected }) });
      return { indexId, lease };
    }
    const leaseId = required(values, 'lease-id');
    if (action === 'renew') return { indexId, lease: renewLease(store, leaseId, ttlSeconds) };
    return { indexId, leaseId, released: releaseLease(store, leaseId).released };
  } finally {
    store.close();
  }
}

/** 임대는 세대를 GC에서 지킬 뿐이다. 작업 상태나 승인을 이 DB에 남기지 않는다. */
function runLease({ values, paths, pretty }: Invocation): number {
  const action = values.action as LeaseAction;
  const outcome = leaseAction(action, values, openKnowledgeBase(paths).dbPath);
  writeDocument({ schema: 'agent-knowledge.lease', schemaVersion: 1, ok: true, status: 'ok', action, ...outcome }, pretty);
  return 0;
}

function runEval({ values, paths, pretty, progress }: Invocation): number {
  const suites = list(values, 'suite');
  const responseVersion = responseVersionFlag(values);
  const variantsPath = single(values, 'variants');
  const recordDir = single(values, 'record');
  const response = runEvaluation({
    suitePaths: suites.length > 0 ? suites : [join(PACKAGE_ROOT, 'evals', 'master'), join(PACKAGE_ROOT, 'evals', 'code')],
    retrievalConfigPath: paths.retrievalConfigPath,
    configuredContext: () => openKnowledgeBase(paths),
    progress,
    ...(responseVersion === undefined ? {} : { responseVersion }),
    ...(variantsPath === undefined ? {} : { variantsPath }),
    ...(recordDir === undefined ? {} : { recordDir }),
    baselines: list(values, 'baseline'),
  });
  writeDocument(response, pretty);
  return response.ok ? 0 : EXIT_CODES['eval-failed'];
}

const HANDLERS: Record<Command, (invocation: Invocation) => number> = {
  validate: runValidate,
  index: runIndexCommand,
  status: runStatus,
  search: runSearch,
  get: runGet,
  eval: runEval,
  capabilities: runCapabilities,
  verify: runVerify,
  lease: runLease,
};

export function runCli(argv: readonly string[]): number {
  // 옵션 해석이 실패해도 오류 문서의 형식은 사용자가 요청한 대로 맞춘다
  const pretty = argv.includes('--pretty');
  try {
    const parsed = parseCommandLine(argv);
    if (parsed.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const { command, values } = parsed;
    return HANDLERS[command]({ values, paths: pathsOf(values), pretty, progress: progressWriter(values.quiet === true) });
  } catch (error) {
    const failure = asKnowledgeError(error);
    writeDocument(errorDocument(knownCommand(argv), failure), pretty);
    return EXIT_CODES[failure.code];
  }
}
