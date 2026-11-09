import { KnowledgeError } from '../errors.js';
import { loadRetrievalConfig, type RetrievalConfig } from '../profiles/config.js';
import { search } from '../retrieval/searcher.js';
import type { OutputItem, RetrievalContext, SearchResponse } from '../retrieval/types.js';
import { findSuiteFiles, loadSuite, type EvalCase, type EvalLocation, type EvalSuite } from './suite.js';
import { materializeWorkspace, type MaterializedWorkspace } from './workspace.js';

interface EvaluationOptions {
  suitePaths: readonly string[];
  retrievalConfigPath: string;
  /** workspace가 없는 평가 묶음에서만 호출한다. */
  configuredContext: () => RetrievalContext;
  progress: (message: string) => void;
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

function suiteContext(suite: EvalSuite, retrieval: RetrievalConfig, workspaces: Map<string, MaterializedWorkspace>, options: EvaluationOptions): RetrievalContext {
  if (suite.workspace === null) return options.configuredContext();
  let workspace = workspaces.get(suite.workspace);
  if (!workspace) {
    workspace = materializeWorkspace(suite.workspace, options.progress);
    workspaces.set(suite.workspace, workspace);
  }
  return { dbPath: workspace.dbPath, sources: workspace.config, retrieval };
}

export function runEvaluation(options: EvaluationOptions): EvaluationResponse {
  const suites = findSuiteFiles(options.suitePaths).map(loadSuite);
  const retrieval = loadRetrievalConfig(options.retrievalConfigPath);
  const workspaces = new Map<string, MaterializedWorkspace>();
  try {
    const results = suites.map((suite): SuiteResult => {
      options.progress(`평가 묶음을 실행합니다: ${suite.suite}`);
      const context = suiteContext(suite, retrieval, workspaces, options);
      const cases = suite.cases.map((testCase) => runCase(context, suite, testCase));
      for (const result of cases) if (!result.passed) options.progress(`실패: ${suite.suite}/${result.id} ${result.failures.join('; ')}`);
      return { suite: suite.suite, profile: suite.profile, file: suite.file, metrics: metricsOf(cases), cases };
    });
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
