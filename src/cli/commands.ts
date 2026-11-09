import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { EXIT_CODES, KnowledgeError } from '../errors.js';
import { runEvaluation } from '../evaluation/runner.js';
import { openKnowledgeBase, type KnowledgeBaseOptions } from '../index.js';
import { runIndex } from '../indexing/indexer.js';
import { openForRead, openForWrite } from '../indexing/store.js';
import { loadRetrievalConfig } from '../profiles/config.js';
import { getItem } from '../retrieval/get.js';
import { search } from '../retrieval/searcher.js';
import { loadSourcesConfig, type SourcesConfig } from '../sources/config.js';
import { resolveCommit } from '../sources/git.js';
import { validateSources } from '../sources/validate.js';
import { compareStrings } from '../util/compare.js';
import { getRequestOf, HELP, knownCommand, list, parseCommandLine, parsePairs, searchRequestOf, single, type Command, type Values } from './args.js';
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

function runIndexCommand({ values, paths, pretty, progress }: Invocation): number {
  const config = loadSourcesConfig(paths.configPath);
  const refOverrides = parsePairs(values, 'ref');
  const store = openForWrite(resolve(paths.dbPath ?? config.database.path));
  try {
    const result = runIndex({ config, store, refOverrides, onProgress: (event) => (event.stage === 'diagnostic' ? writeDiagnostic : progress)(event.message) });
    const commits = Object.fromEntries(result.sources.map((source) => [source.sourceId, source.commit]));
    progress(result.status === 'published' ? `색인 세대 ${result.generation}을(를) 게시했습니다` : `변경이 없어 세대 ${result.generation}을(를) 유지합니다`);
    writeDocument({ schema: 'agent-knowledge.index', schemaVersion: 1, ok: true, ...result, commits }, pretty);
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

function runStatus({ paths, pretty }: Invocation): number {
  const kb = openKnowledgeBase(paths);
  const store = openForRead(kb.dbPath);
  let snapshot: StatusSnapshot;
  try {
    snapshot = store.read(readStatus);
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
      schemaVersion: 1,
      ok: true,
      status: 'ok',
      ...rest,
      sources: reported,
      vector: { implemented: false, state: 'not-implemented' },
      diagnostics: diagnostics.slice(0, SHOWN_DIAGNOSTICS),
      diagnosticsTotal: diagnostics.length,
    },
    pretty,
  );
  return 0;
}

function runSearch({ values, paths, pretty }: Invocation): number {
  const request = searchRequestOf(values);
  const response = search(openKnowledgeBase(paths), request);
  writeDocument(response, pretty);
  return response.status === 'no-results' ? NO_RESULTS_EXIT : 0;
}

function runGet({ values, paths, pretty }: Invocation): number {
  const request = getRequestOf(values);
  writeDocument(getItem(openKnowledgeBase(paths), request), pretty);
  return 0;
}

function runEval({ values, paths, pretty, progress }: Invocation): number {
  const suites = list(values, 'suite');
  const response = runEvaluation({
    suitePaths: suites.length > 0 ? suites : [join(PACKAGE_ROOT, 'evals', 'master'), join(PACKAGE_ROOT, 'evals', 'code')],
    retrievalConfigPath: paths.retrievalConfigPath,
    configuredContext: () => openKnowledgeBase(paths),
    progress,
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
