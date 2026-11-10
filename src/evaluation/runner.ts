import { KnowledgeError } from '../errors.js';
import { loadRetrievalConfig, type RetrievalConfig } from '../profiles/config.js';
import { search } from '../retrieval/searcher.js';
import type { OutputItem, RetrievalContext, SearchResponse } from '../retrieval/types.js';
import { runRanking, type RankingEvaluation, type SuiteContext } from './ranking.js';
import { loadRankingSuite, loadVariants, suiteSchemaVersionOf, type RankingSuite } from './ranking-suite.js';
import { findSuiteFiles, loadSuite, type EvalCase, type EvalLocation, type EvalSuite } from './suite.js';
import { materializeWorkspace, type MaterializedWorkspace } from './workspace.js';

interface EvaluationOptions {
  suitePaths: readonly string[];
  retrievalConfigPath: string;
  /** workspace가 없는 평가 묶음에서만 호출한다. */
  configuredContext: () => RetrievalContext;
  progress: (message: string) => void;
  /** 아래 값을 하나라도 주거나 형식 2 평가 묶음이 있으면 응답 형식 2로 낸다. */
  responseVersion?: 1 | 2;
  variantsPath?: string;
  recordDir?: string;
  baselines?: readonly string[];
}

interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  /** 기대한 근거(ID + 원본 위치)의 수 */
  expected: number;
  found: number;
  /** 기대한 근거 중 가장 앞선 결과의 순위. 없으면 null이다. */
  firstRank: number | null;
  /** 반환된 항목 수. 재현율은 이 안에서 계산한다. */
  k: number;
}

interface Metrics {
  casesTotal: number;
  casesPassed: number;
  recallAtK: number | null;
  mrr: number | null;
}

interface SuiteResult {
  suite: string;
  profile: string;
  file: string;
  metrics: Metrics;
  cases: CaseResult[];
}

interface EvaluationResponse {
  schema: 'agent-knowledge.eval';
  schemaVersion: 1;
  ok: boolean;
  status: 'passed' | 'failed';
  summary: Metrics;
  suites: SuiteResult[];
  error?: { code: 'eval-failed'; message: string; detail: Record<string, unknown> };
}

/** 기존 평가(형식 1 묶음)는 summary·suites에 그대로 두고, 순위 평가는 ranking에 따로 둔다. 두 지표를 섞지 않는다. */
interface EvaluationResponseV2 {
  schema: 'agent-knowledge.eval';
  schemaVersion: 2;
  ok: boolean;
  status: 'passed' | 'failed';
  summary: Metrics | null;
  suites: SuiteResult[];
  ranking: RankingEvaluation | null;
  error?: { code: 'eval-failed'; message: string; detail: Record<string, unknown> };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function metricsOf(cases: readonly CaseResult[]): Metrics {
  const measured = cases.filter((result) => result.expected > 0);
  const expected = measured.reduce((sum, result) => sum + result.expected, 0);
  const found = measured.reduce((sum, result) => sum + result.found, 0);
  return {
    casesTotal: cases.length,
    casesPassed: cases.filter((result) => result.passed).length,
    recallAtK: expected === 0 ? null : round(found / expected),
    mrr: measured.length === 0 ? null : round(measured.reduce((sum, result) => sum + (result.firstRank === null ? 0 : 1 / result.firstRank), 0) / measured.length),
  };
}

function coversLocation(item: OutputItem, location: EvalLocation): boolean {
  const { path, startLine, endLine } = item.provenance;
  return (location.sourceId === undefined || location.sourceId === item.sourceId) && location.path === path && startLine <= location.startLine && endLine >= location.endLine;
}

function checkResponse(testCase: EvalCase, response: SearchResponse): CaseResult {
  const { expect } = testCase;
  const failures: string[] = [];
  if (expect.status !== undefined && response.status !== expect.status) failures.push(`status-mismatch: expected ${expect.status}, got ${response.status}`);

  const byId = new Map(response.items.map((item) => [item.id, item]));
  const ranks: number[] = [];
  let found = 0;
  const record = (item: OutputItem | undefined, missing: string): void => {
    if (!item) {
      failures.push(missing);
      return;
    }
    found += 1;
    ranks.push(item.selection.rank);
  };
  for (const id of expect.items) record(byId.get(id), `item-missing: ${id}`);
  for (const location of expect.locations) record(response.items.find((item) => coversLocation(item, location)), `location-missing: ${location.sourceId ?? '*'}:${location.path}:${location.startLine}-${location.endLine}`);

  for (const [sectionId, ids] of Object.entries(expect.sections)) {
    const shown = response.sections.find((section) => section.id === sectionId)?.itemIds ?? [];
    for (const id of ids) if (!shown.includes(id)) failures.push(`section-missing: ${sectionId}: ${id}`);
  }
  for (const id of expect.absent) if (byId.has(id)) failures.push(`unexpected-item: ${id}`);
  for (const id of expect.unconfirmed) {
    const item = byId.get(id);
    if (!item) failures.push(`unconfirmed-missing: ${id}`);
    else if (item.knowledge.confirmed) failures.push(`unexpectedly-confirmed: ${id}`);
  }
  if (expect.error !== undefined) failures.push(`expected-error: ${expect.error}, got ${response.status}`);

  const expected = expect.items.length + expect.locations.length;
  return { id: testCase.id, passed: failures.length === 0, failures, expected, found, firstRank: ranks.length === 0 ? null : Math.min(...ranks), k: response.items.length };
}

function requestOf(suite: EvalSuite, testCase: EvalCase): Record<string, unknown> {
  const { query, scope, filters, task, version, limit } = testCase;
  const optional = Object.entries({ query, filters, task, version, limit }).filter(([, value]) => value !== undefined);
  return { profile: suite.profile, scope, ...Object.fromEntries(optional) };
}

function runCase(context: RetrievalContext, suite: EvalSuite, testCase: EvalCase): CaseResult {
  const { expect } = testCase;
  const expected = expect.items.length + expect.locations.length;
  try {
    return checkResponse(testCase, search(context, requestOf(suite, testCase)));
  } catch (error) {
    if (!(error instanceof KnowledgeError)) throw error;
    const failures = expect.error === error.code ? [] : [expect.error === undefined ? `unexpected-error: ${error.code}: ${error.message}` : `expected-error: ${expect.error}, got ${error.code}`];
    return { id: testCase.id, passed: failures.length === 0, failures, expected, found: 0, firstRank: null, k: 0 };
  }
}

function suiteContext(suite: Pick<EvalSuite, 'workspace'>, retrieval: RetrievalConfig, workspaces: Map<string, MaterializedWorkspace>, options: EvaluationOptions): SuiteContext {
  if (suite.workspace === null) return { context: options.configuredContext(), kind: 'configured' };
  let workspace = workspaces.get(suite.workspace);
  if (!workspace) {
    workspace = materializeWorkspace(suite.workspace, options.progress);
    workspaces.set(suite.workspace, workspace);
  }
  return { context: { dbPath: workspace.dbPath, sources: workspace.config, retrieval }, kind: 'workspace' };
}

function runLegacySuites(suites: readonly EvalSuite[], retrieval: RetrievalConfig, workspaces: Map<string, MaterializedWorkspace>, options: EvaluationOptions): SuiteResult[] {
  return suites.map((suite): SuiteResult => {
    options.progress(`평가 묶음을 실행합니다: ${suite.suite}`);
    const { context } = suiteContext(suite, retrieval, workspaces, options);
    const cases = suite.cases.map((testCase) => runCase(context, suite, testCase));
    for (const result of cases) if (!result.passed) options.progress(`실패: ${suite.suite}/${result.id} ${result.failures.join('; ')}`);
    return { suite: suite.suite, profile: suite.profile, file: suite.file, metrics: metricsOf(cases), cases };
  });
}

function wantsVersion2(options: EvaluationOptions): boolean {
  return options.responseVersion === 2 || options.variantsPath !== undefined || options.recordDir !== undefined || (options.baselines?.length ?? 0) > 0;
}

export function runEvaluation(options: EvaluationOptions): EvaluationResponse | EvaluationResponseV2 {
  const files = findSuiteFiles(options.suitePaths);
  const rankingFiles = files.filter((file) => suiteSchemaVersionOf(file) === 2);
  if (rankingFiles.length > 0 || wantsVersion2(options)) return runEvaluationV2(options, files, new Set(rankingFiles));

  const suites = files.map(loadSuite);
  const retrieval = loadRetrievalConfig(options.retrievalConfigPath);
  const workspaces = new Map<string, MaterializedWorkspace>();
  try {
    const results = runLegacySuites(suites, retrieval, workspaces, options);
    const summary = metricsOf(results.flatMap((suite) => suite.cases));
    const ok = summary.casesPassed === summary.casesTotal;
    return {
      schema: 'agent-knowledge.eval',
      schemaVersion: 1,
      ok,
      status: ok ? 'passed' : 'failed',
      summary,
      suites: results,
      ...(ok ? {} : { error: { code: 'eval-failed' as const, message: `평가 사례 ${summary.casesTotal - summary.casesPassed}건이 실패했습니다`, detail: {} } }),
    };
  } finally {
    for (const workspace of workspaces.values()) workspace.dispose();
  }
}

function runEvaluationV2(options: EvaluationOptions, files: readonly string[], rankingFiles: ReadonlySet<string>): EvaluationResponseV2 {
  const legacy = files.filter((file) => !rankingFiles.has(file)).map(loadSuite);
  const ranking: RankingSuite[] = files.filter((file) => rankingFiles.has(file)).map(loadRankingSuite);
  // 결과·기록·외부 순위 목록이 묶음 이름으로 사례를 구분하므로 이름이 겹치면 서로 덮어쓴다
  const seen = new Map<string, string>();
  for (const suite of ranking) {
    const other = seen.get(suite.suite);
    if (other !== undefined) throw new KnowledgeError('eval-failed', `순위 평가 묶음 이름이 겹칩니다: ${suite.suite}`, { reason: 'suite-invalid', suite: suite.suite, files: [other, suite.file] });
    seen.set(suite.suite, suite.file);
  }
  if (options.responseVersion === 1 && ranking.length > 0) throw new KnowledgeError('usage', '순위 평가 묶음의 결과는 형식 2로만 낼 수 있습니다. --response-version 1을 빼 주십시오', { flag: 'response-version', suites: ranking.map((suite) => suite.file) });
  const rankingOnly = options.variantsPath !== undefined || options.recordDir !== undefined || (options.baselines?.length ?? 0) > 0;
  if (rankingOnly && ranking.length === 0) throw new KnowledgeError('eval-failed', '--variants·--record·--baseline에는 형식 2 평가 묶음이 필요합니다', { reason: 'no-ranking-suites', suites: files });
  const retrieval = loadRetrievalConfig(options.retrievalConfigPath);
  const variants = loadVariants(options.variantsPath, options.retrievalConfigPath);
  const workspaces = new Map<string, MaterializedWorkspace>();
  try {
    const results = runLegacySuites(legacy, retrieval, workspaces, options);
    const summary = results.length === 0 ? null : metricsOf(results.flatMap((suite) => suite.cases));
    const run =
      ranking.length === 0
        ? null
        : runRanking({ suites: ranking, variants, contextOf: (suite) => suiteContext(suite, retrieval, workspaces, options), baselines: options.baselines ?? [], recordDir: options.recordDir, progress: options.progress });
    const legacyFailed = summary === null ? 0 : summary.casesTotal - summary.casesPassed;
    const rankingErrors = run === null ? 0 : run.evaluation.variants.reduce((sum, variant) => sum + variant.metrics.errors, 0);
    const ok = legacyFailed === 0 && rankingErrors === 0;
    const response: EvaluationResponseV2 = {
      schema: 'agent-knowledge.eval',
      schemaVersion: 2,
      ok,
      status: ok ? 'passed' : 'failed',
      summary,
      suites: results,
      ranking: run?.evaluation ?? null,
      ...(ok ? {} : { error: { code: 'eval-failed' as const, message: `기존 평가 실패 ${legacyFailed}건, 순위 평가 오류 ${rankingErrors}건이 있습니다`, detail: { legacyFailed, rankingErrors } } }),
    };
    run?.write(response);
    return response;
  } finally {
    for (const workspace of workspaces.values()) workspace.dispose();
  }
}
