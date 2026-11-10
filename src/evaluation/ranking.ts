import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { openForRead } from '../indexing/store.js';
import { CHUNKER_VERSION, PARSER_VERSION, RESOLVER_VERSION, TOKENIZER_VERSION } from '../parsing/versions.js';
import { configHashOf } from '../profiles/config.js';
import { QUERY_VERSION, RANKER_VERSIONS, searchV2 } from '../retrieval/searcher.js';
import type { OutputItemV2, RetrievalContext, SearchResponseV2 } from '../retrieval/types.js';
import type { SourcesConfig } from '../sources/config.js';
import { isDirty } from '../sources/git.js';
import { compareStrings } from '../util/compare.js';
import { sha256 } from '../util/hash.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../util/package-info.js';
import type { RankingCase, RankingSuite, RankingVariant, RankingVariants, RelevantEntry } from './ranking-suite.js';

/** 직접 순위는 항상 상위 10개를 받아 5와 10에서 자른다. limit가 바뀌어 재현율의 분모가 달라지는 일을 막는다. */
export const DIRECT_K = 10;
const DIRECT_INCLUDE = { mandatory: false, dependencies: false, links: false } as const;
const CONTEXT_INCLUDE = { mandatory: true, dependencies: true, links: true } as const;
const REVIEW_NOTE = '잠정 정답입니다. 사람이 원문과 대조한 뒤 judgment를 reviewed로 바꾸거나 정답을 고치십시오.';

interface AnswerLocation {
  sourceId: string | null;
  path: string;
  startLine: number;
  endLine: number;
}

/** 정답 하나. 같은 항목으로 해석되는 항목 ID와 위치는 한 정답으로 합쳐 두 번 세지 않는다. */
interface Answer {
  key: string;
  entries: string[];
  accept: Set<string>;
  location: AnswerLocation | null;
  required: boolean;
  grade: number;
  unresolved: boolean;
}

export interface RankedEntry {
  rank: number;
  id: string;
  segmentId: string | null;
  kind: string;
  projectId: string;
  sourceId: string;
  path: string;
  /** 조각이면 조각의 줄 범위다. */
  startLine: number;
  endLine: number;
  title: string;
}

interface DirectCase {
  outcome: SearchResponseV2['retrieval']['outcome'];
  directMatched: number;
  recallAt5: number;
  recallAt10: number;
  hitAt5: number;
  hitAt10: number;
  reciprocalRank: number;
  ranked: RankedEntry[];
}

interface ContextCase {
  requiredTotal: number;
  requiredFound: number;
  coverage: number | null;
  /** 문맥 응답에서 정답을 채운 항목의 묶음별 수. 같은 항목은 필수 묶음에 먼저 들어가므로 직접 일치여도 mandatory로 셀 수 있다. */
  foundByGroup: Record<string, number>;
  /** 직접 순위 상위 10개에는 없고 필수·의존·연결 자료로만 문맥에 들어온 정답 수. 필수 자료가 포함률을 부풀리는지 보는 값이다. */
  foundBySupplementaryOnly: number;
  missing: string[];
  items: number;
  excerptChars: number;
  responseBytes: number;
  truncated: boolean;
}

interface Composition {
  byKind: Record<string, number>;
  byProject: Record<string, number>;
  maxProjectShare: number | null;
  kindCoverage: number | null;
}

export interface RankingCaseResult {
  suite: string;
  id: string;
  judgment: 'provisional' | 'reviewed';
  answers: { key: string; entries: string[]; required: boolean; grade: number; unresolved: boolean; directRank: number | null; contextGroup: string | null }[];
  direct: DirectCase | null;
  context: ContextCase | null;
  composition: Composition | null;
  timings: { directMs: number | null; contextMs: number | null };
  error: { code: string; message: string; detail: unknown } | null;
}

interface DirectAggregate {
  cases: number;
  recallAt5: number | null;
  recallAt10: number | null;
  mrrAt10: number | null;
  hitAt5: number | null;
  hitAt10: number | null;
}

interface Distribution {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface RankingMetrics {
  cases: number;
  errors: number;
  unresolvedAnswers: number;
  direct: { all: DirectAggregate; singleAnswer: DirectAggregate; multiAnswer: DirectAggregate };
  context: { cases: number; requiredCoverage: number | null; foundBySupplementaryOnly: number; meanItems: number | null; meanResponseBytes: number | null; truncatedCases: number };
  composition: { meanMaxProjectShare: number | null; meanKindCoverage: number | null };
  judgments: { provisional: number; reviewed: number };
  latencyMs: { direct: Distribution; context: Distribution };
}

export interface CorpusRecord {
  suite: string;
  kind: 'workspace' | 'configured';
  indexId: string | null;
  generation: number;
  sources: {
    sourceId: string;
    projectId: string;
    requestedRef: string;
    refOrigin: string | null;
    commit: string;
    configSha256: string | null;
    include: string[] | null;
    exclude: string[] | null;
    defaultKind: string | null;
    rules: unknown;
    /** 색인한 문서 경로에 커밋되지 않은 변경이 있었는지. 추적되지 않은 새 문서는 보지 않는다. 확인할 수 없으면 null이다. */
    worktreeClean: boolean | null;
  }[];
}

export interface SuiteContext {
  context: RetrievalContext;
  kind: 'workspace' | 'configured';
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! * 10) / 10;
  return { p50: at(0.5), p95: at(0.95), max: Math.round(sorted[sorted.length - 1]! * 10) / 10 };
}

function histogram(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => compareStrings(a, b)));
}

const ITEM_LOCATION = `FROM generation_items g JOIN items i ON i.item_pk = g.item_pk JOIN documents d ON d.document_pk = i.document_pk WHERE g.generation = ?`;

/**
 * 위치 정답은 그 위치를 덮는 가장 작은 항목으로 해석한다. 문서 전체 같은 넓은 상위 항목이 맞힌 것으로 세지 않는다.
 * 정답은 사례 요청의 유효 범위 안 원본(sourceIds)에서만 푼다. 범위 밖 항목은 검색이 돌려줄 수 없으므로 풀리지 않은 정답으로 센다.
 * sourceId가 없는 위치 정답은 형식 1 평가처럼 어느 원본이든 되며, 범위 안 원본마다 가장 작은 항목을 하나씩 받아들인다.
 */
function resolveAnswers(db: DatabaseSync, generation: number, entries: readonly RelevantEntry[], sourceIds: readonly string[]): Answer[] {
  const answers: Answer[] = [];
  const inScope = sourceIds.length === 0 ? ' AND 0' : ` AND d.source_id IN (${sourceIds.map(() => '?').join(', ')})`;
  for (const entry of entries) {
    const required = entry.required ?? true;
    const grade = entry.grade ?? 1;
    let resolved: Omit<Answer, 'required' | 'grade' | 'entries'>;
    let label: string;
    if ('id' in entry) {
      const row = db.prepare(`SELECT d.source_id AS sourceId, d.path AS path, i.start_line AS startLine, i.end_line AS endLine ${ITEM_LOCATION}${inScope} AND i.item_id = ?`).get(generation, ...sourceIds, entry.id) as unknown as AnswerLocation | undefined;
      label = entry.id;
      resolved = { key: entry.id, accept: new Set(row ? [entry.id] : []), location: row ?? null, unresolved: row === undefined };
    } else {
      const { path, startLine, endLine, sourceId } = entry.location;
      const rows = db
        .prepare(`SELECT d.source_id AS sourceId, i.item_id AS id, i.start_line AS startLine, i.end_line AS endLine ${ITEM_LOCATION}${inScope} AND d.path = ? AND i.start_line <= ? AND i.end_line >= ?${sourceId === undefined ? '' : ' AND d.source_id = ?'}`)
        .all(generation, ...sourceIds, path, startLine, endLine, ...(sourceId === undefined ? [] : [sourceId])) as unknown as { sourceId: string; id: string; startLine: number; endLine: number }[];
      const sorted = rows.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine) || compareStrings(a.id, b.id));
      const smallestBySource = new Map<string, string>();
      for (const row of sorted) if (!smallestBySource.has(row.sourceId)) smallestBySource.set(row.sourceId, row.id);
      const accepted = [...smallestBySource.values()].sort(compareStrings);
      label = `${sourceId ?? '*'}:${path}:${startLine}-${endLine}`;
      // 원본이 여럿이면 어느 한 항목 ID를 대표로 삼지 않고 위치 표기를 키로 쓴다
      resolved = { key: accepted.length === 1 ? accepted[0]! : label, accept: new Set(accepted), location: { sourceId: sourceId ?? null, path, startLine, endLine }, unresolved: accepted.length === 0 };
    }
    const existing = answers.find((answer) => answer.key === resolved.key);
    if (existing) {
      existing.entries.push(label);
      existing.required ||= required;
      existing.grade = Math.max(existing.grade, grade);
      existing.location ??= resolved.location;
      continue;
    }
    answers.push({ ...resolved, entries: [label], required, grade });
  }
  return answers;
}

/** 한 결과는 정답 하나만 채운다. 같은 항목이 여러 정답으로 세어지는 이중 계산을 막는다. */
function matchRanks(ranked: readonly string[], answers: readonly Answer[]): (number | null)[] {
  const ranks: (number | null)[] = answers.map(() => null);
  ranked.forEach((id, index) => {
    const at = answers.findIndex((answer, position) => ranks[position] === null && answer.accept.has(id));
    if (at >= 0) ranks[at] = index + 1;
  });
  return ranks;
}

function rankedEntryOf(item: OutputItemV2): RankedEntry {
  const segment = item.segment;
  return {
    rank: item.selection.rank,
    id: item.id,
    segmentId: segment?.id ?? null,
    kind: item.kind,
    projectId: item.projectId,
    sourceId: item.sourceId,
    path: item.provenance.path,
    startLine: segment?.startLine ?? item.provenance.startLine,
    endLine: segment?.endLine ?? item.provenance.endLine,
    title: item.title,
  };
}

function directCaseOf(response: SearchResponseV2, answers: readonly Answer[]): { direct: DirectCase; ranks: (number | null)[] } {
  const ranked = response.items.filter((item) => item.group === 'direct').slice(0, DIRECT_K);
  const ranks = matchRanks(ranked.map((item) => item.id), answers);
  const within = (k: number): number => ranks.filter((rank) => rank !== null && rank <= k).length;
  const first = Math.min(...ranks.map((rank) => rank ?? Infinity));
  const total = answers.length;
  return {
    ranks,
    direct: {
      outcome: response.retrieval.outcome,
      directMatched: response.retrieval.counts.directMatched,
      recallAt5: round(within(5) / total),
      recallAt10: round(within(10) / total),
      hitAt5: within(5) > 0 ? 1 : 0,
      hitAt10: within(10) > 0 ? 1 : 0,
      reciprocalRank: first === Infinity ? 0 : round(1 / first),
      ranked: ranked.map(rankedEntryOf),
    },
  };
}

function contextCaseOf(response: SearchResponseV2, answers: readonly Answer[], directRanks: readonly (number | null)[]): { context: ContextCase; groups: (string | null)[] } {
  const ranks = matchRanks(response.items.map((item) => item.id), answers);
  const groups = ranks.map((rank) => (rank === null ? null : response.items[rank - 1]!.group));
  const required = answers.map((answer, index) => ({ answer, group: groups[index] ?? null, directRank: directRanks[index] ?? null })).filter(({ answer }) => answer.required);
  const found = required.filter(({ group }) => group !== null);
  return {
    groups,
    context: {
      requiredTotal: required.length,
      requiredFound: found.length,
      coverage: required.length === 0 ? null : round(found.length / required.length),
      foundByGroup: histogram(found.map(({ group }) => group!)),
      // 직접 상위 10개 밖이어도 문맥의 직접 묶음으로 들어왔으면(필수 항목이 빠져 순위가 당겨진 경우) 보충 자료 덕분이 아니다
      foundBySupplementaryOnly: found.filter(({ directRank, group }) => directRank === null && group !== 'direct').length,
      missing: required.filter(({ group }) => group === null).map(({ answer }) => answer.key),
      items: response.items.length,
      excerptChars: response.items.reduce((sum, item) => sum + item.excerpt.length, 0),
      responseBytes: Buffer.byteLength(JSON.stringify(response), 'utf8'),
      truncated: response.budget.truncated,
    },
  };
}

function compositionOf(ranked: readonly RankedEntry[], expectKinds: RankingCase['expectKinds']): Composition {
  const byProject = histogram(ranked.map((entry) => entry.projectId));
  const kinds = new Set(ranked.map((entry) => entry.kind));
  const largest = Math.max(0, ...Object.values(byProject));
  return {
    byKind: histogram(ranked.map((entry) => entry.kind)),
    byProject,
    maxProjectShare: ranked.length === 0 ? null : round(largest / ranked.length),
    kindCoverage: expectKinds === undefined || expectKinds.length === 0 ? null : round(expectKinds.filter((kind) => kinds.has(kind)).length / expectKinds.length),
  };
}

function requestsOf(suite: RankingSuite, testCase: RankingCase, variant: RankingVariant): { direct: Record<string, unknown>; context: Record<string, unknown> } {
  const base = { ...(suite.defaults?.request ?? {}), ...testCase.request, profile: suite.profile, responseVersion: 2, ...variant.request };
  return {
    direct: { ...base, include: DIRECT_INCLUDE, limit: DIRECT_K },
    context: { ...base, include: { ...CONTEXT_INCLUDE, ...(testCase.context?.include ?? {}) }, ...(testCase.context?.budget === undefined ? {} : { budget: testCase.context.budget }) },
  };
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

interface CaseRun {
  result: RankingCaseResult;
  answers: Answer[];
  requests: ReturnType<typeof requestsOf>;
  generation: number | null;
}

function runCase(context: RetrievalContext, suite: RankingSuite, testCase: RankingCase, variant: RankingVariant): CaseRun {
  const requests = requestsOf(suite, testCase, variant);
  const judgment = testCase.judgment ?? suite.judgments;
  const variantContext: RetrievalContext = { ...context, retrieval: variant.retrieval };
  const failed = (error: unknown, timings: RankingCaseResult['timings']): CaseRun => {
    if (!(error instanceof KnowledgeError)) throw error;
    return {
      result: { suite: suite.suite, id: testCase.id, judgment, answers: [], direct: null, context: null, composition: null, timings, error: { code: error.code, message: error.message, detail: error.detail ?? {} } },
      answers: [],
      requests,
      generation: null,
    };
  };
  let direct: { value: SearchResponseV2; ms: number };
  try {
    direct = timed(() => searchV2(variantContext, requests.direct));
  } catch (error) {
    return failed(error, { directMs: null, contextMs: null });
  }
  let contextRun: { value: SearchResponseV2; ms: number };
  try {
    contextRun = timed(() => searchV2(variantContext, requests.context));
  } catch (error) {
    return failed(error, { directMs: direct.ms, contextMs: null });
  }
  const generation = direct.value.index.generation;
  const store = openForRead(context.dbPath);
  let answers: Answer[];
  try {
    // 직접 응답의 index.sources는 요청 프로젝트와 허용 연결 프로젝트의 원본, 곧 유효 범위다
    const sourceIds = direct.value.index.sources.map((source) => source.sourceId);
    answers = store.read((db) => resolveAnswers(db, generation, testCase.relevant, sourceIds));
  } finally {
    store.close();
  }
  const { direct: directCase, ranks } = directCaseOf(direct.value, answers);
  const { context: contextCase, groups } = contextCaseOf(contextRun.value, answers, ranks);
  return {
    answers,
    requests,
    generation,
    result: {
      suite: suite.suite,
      id: testCase.id,
      judgment,
      answers: answers.map((answer, index) => ({ key: answer.key, entries: answer.entries, required: answer.required, grade: answer.grade, unresolved: answer.unresolved, directRank: ranks[index] ?? null, contextGroup: groups[index] ?? null })),
      direct: directCase,
      context: contextCase,
      composition: compositionOf(directCase.ranked, testCase.expectKinds),
      timings: { directMs: direct.ms, contextMs: contextRun.ms },
      error: null,
    },
  };
}

function directAggregate(cases: readonly RankingCaseResult[]): DirectAggregate {
  const measured = cases.map((result) => result.direct).filter((direct): direct is DirectCase => direct !== null);
  return {
    cases: measured.length,
    recallAt5: mean(measured.map((direct) => direct.recallAt5)),
    recallAt10: mean(measured.map((direct) => direct.recallAt10)),
    mrrAt10: mean(measured.map((direct) => direct.reciprocalRank)),
    hitAt5: mean(measured.map((direct) => direct.hitAt5)),
    hitAt10: mean(measured.map((direct) => direct.hitAt10)),
  };
}

export function metricsOf(cases: readonly RankingCaseResult[]): RankingMetrics {
  const contexts = cases.map((result) => result.context).filter((context): context is ContextCase => context !== null);
  const compositions = cases.map((result) => result.composition).filter((composition): composition is Composition => composition !== null);
  return {
    cases: cases.length,
    errors: cases.filter((result) => result.error !== null).length,
    unresolvedAnswers: cases.reduce((sum, result) => sum + result.answers.filter((answer) => answer.unresolved).length, 0),
    direct: {
      all: directAggregate(cases),
      singleAnswer: directAggregate(cases.filter((result) => result.answers.length === 1)),
      multiAnswer: directAggregate(cases.filter((result) => result.answers.length > 1)),
    },
    context: {
      cases: contexts.length,
      requiredCoverage: mean(contexts.flatMap((context) => (context.coverage === null ? [] : [context.coverage]))),
      foundBySupplementaryOnly: contexts.reduce((sum, context) => sum + context.foundBySupplementaryOnly, 0),
      meanItems: mean(contexts.map((context) => context.items)),
      meanResponseBytes: mean(contexts.map((context) => context.responseBytes)),
      truncatedCases: contexts.filter((context) => context.truncated).length,
    },
    composition: {
      meanMaxProjectShare: mean(compositions.flatMap((composition) => (composition.maxProjectShare === null ? [] : [composition.maxProjectShare]))),
      meanKindCoverage: mean(compositions.flatMap((composition) => (composition.kindCoverage === null ? [] : [composition.kindCoverage]))),
    },
    judgments: { provisional: cases.filter((result) => result.judgment === 'provisional').length, reviewed: cases.filter((result) => result.judgment === 'reviewed').length },
    latencyMs: {
      direct: distribution(cases.flatMap((result) => (result.timings.directMs === null ? [] : [result.timings.directMs]))),
      context: distribution(cases.flatMap((result) => (result.timings.contextMs === null ? [] : [result.timings.contextMs]))),
    },
  };
}

// ---- 외부 순위 목록(ranking-run) ----

const rankingRunSchema = z.looseObject({
  schema: z.literal('agent-knowledge.ranking-run'),
  schemaVersion: z.literal(1),
  system: z.looseObject({ name: z.string().min(1), version: z.string().nullable().optional() }),
  corpus: z.looseObject({ sources: z.array(z.looseObject({ sourceId: z.string().min(1), commit: z.string().min(1) })) }),
  cases: z.array(
    z.looseObject({
      suite: z.string().min(1),
      id: z.string().min(1),
      ranked: z.array(z.looseObject({ path: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive(), sourceId: z.string().min(1).nullable().optional() })),
    }),
  ),
});

type RankingRun = z.infer<typeof rankingRunSchema>;
type OverlapEntry = { path: string; startLine: number; endLine: number; sourceId?: string | null | undefined };

/** 외부 시스템은 항목 ID가 없으므로 위치가 겹치면 맞힌 것으로 본다. 넓은 범위가 유리하므로 같은 규칙으로 우리 결과도 다시 센다. */
function overlaps(entry: OverlapEntry, location: AnswerLocation): boolean {
  if (entry.path !== location.path) return false;
  if (entry.sourceId && location.sourceId && entry.sourceId !== location.sourceId) return false;
  return entry.startLine <= location.endLine && entry.endLine >= location.startLine;
}

function overlapScore(ranked: readonly OverlapEntry[], answers: readonly Answer[]): { recallAt5: number; recallAt10: number; reciprocalRank: number } {
  const ranks: (number | null)[] = answers.map(() => null);
  ranked.slice(0, DIRECT_K).forEach((entry, index) => {
    const at = answers.findIndex((answer, position) => ranks[position] === null && answer.location !== null && overlaps(entry, answer.location));
    if (at >= 0) ranks[at] = index + 1;
  });
  const within = (k: number): number => ranks.filter((rank) => rank !== null && rank <= k).length;
  const first = Math.min(...ranks.map((rank) => rank ?? Infinity));
  return { recallAt5: round(within(5) / answers.length), recallAt10: round(within(10) / answers.length), reciprocalRank: first === Infinity ? 0 : round(1 / first) };
}

function overlapAggregate(scores: readonly { recallAt5: number; recallAt10: number; reciprocalRank: number }[]): { cases: number; recallAt5: number | null; recallAt10: number | null; mrrAt10: number | null } {
  return {
    cases: scores.length,
    recallAt5: mean(scores.map((score) => score.recallAt5)),
    recallAt10: mean(scores.map((score) => score.recallAt10)),
    mrrAt10: mean(scores.map((score) => score.reciprocalRank)),
  };
}

export interface BaselineReport {
  file: string;
  sha256: string;
  system: { name: string; version: string | null };
  /** 외부 목록과 이 평가가 같은 커밋을 봤는지. 다르면 비교 결과를 그대로 믿을 수 없다. */
  corpus: { matches: boolean; mismatches: { sourceId: string; ours: string | null; theirs: string | null }[] };
  missingCases: string[];
  metrics: ReturnType<typeof overlapAggregate>;
  ours: { variant: string; metrics: ReturnType<typeof overlapAggregate> }[];
}

function loadRankingRun(file: string): { run: RankingRun; sha256: string } {
  let text: string;
  let raw: unknown;
  try {
    text = readFileSync(file, 'utf8').replace(/^﻿/, '');
    raw = JSON.parse(text);
  } catch (error) {
    throw new KnowledgeError('eval-failed', `비교할 순위 목록을 읽을 수 없습니다: ${file}`, { reason: 'baseline-invalid', file, message: (error as Error).message });
  }
  const parsed = rankingRunSchema.safeParse(raw);
  if (!parsed.success) throw new KnowledgeError('eval-failed', `비교할 순위 목록의 형식이 올바르지 않습니다: ${file}`, { reason: 'baseline-invalid', file, issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  return { run: parsed.data, sha256: sha256(text) };
}

// ---- 실행 ----

export interface RankingEvaluation {
  baselineVariant: string;
  variants: {
    id: string;
    description: string | null;
    ranker: 'legacy' | 'bm25';
    rankerVersion: string;
    segments: boolean;
    flatKindWeights: boolean;
    configHash: { master: string; code: string };
    metrics: RankingMetrics;
    suites: { suite: string; profile: string; corpus: string; judgments: string; file: string; metrics: RankingMetrics; cases: RankingCaseResult[] }[];
  }[];
  comparisons: {
    variant: string;
    against: string;
    direct: { recallAt5: number | null; recallAt10: number | null; mrrAt10: number | null };
    context: { requiredCoverage: number | null };
    cases: { better: number; worse: number; same: number };
  }[];
  baselines: BaselineReport[];
  corpora: CorpusRecord[];
  record: { dir: string; files: string[] } | null;
}

export interface RankingOptions {
  suites: readonly RankingSuite[];
  variants: RankingVariants;
  contextOf: (suite: RankingSuite) => SuiteContext;
  baselines: readonly string[];
  recordDir: string | undefined;
  progress: (message: string) => void;
}

function delta(value: number | null, base: number | null): number | null {
  return value === null || base === null ? null : round(value - base);
}

function sameAs(a: DirectCase | null, b: DirectCase | null): number {
  const key = (direct: DirectCase | null): [number, number] => (direct === null ? [-1, -1] : [direct.recallAt10, direct.reciprocalRank]);
  const [ra, ma] = key(a);
  const [rb, mb] = key(b);
  return ra !== rb ? Math.sign(ra - rb) : Math.sign(ma - mb);
}

function pathsBySource(db: DatabaseSync, generation: number): Map<string, string[]> {
  const rows = db.prepare('SELECT d.source_id AS sourceId, d.path AS path FROM generation_documents g JOIN documents d ON d.document_pk = g.document_pk WHERE g.generation = ? ORDER BY d.source_id, d.path').all(generation) as unknown as { sourceId: string; path: string }[];
  const paths = new Map<string, string[]>();
  for (const row of rows) paths.set(row.sourceId, [...(paths.get(row.sourceId) ?? []), row.path]);
  return paths;
}

function corpusOf(suite: RankingSuite, suiteContext: SuiteContext, generation: number): CorpusRecord {
  const { context, kind } = suiteContext;
  const store = openForRead(context.dbPath);
  let indexId: string | null;
  let rows: { sourceId: string; projectId: string; requestedRef: string; refOrigin: string | null; commit: string; configSha256: string | null }[];
  let paths: Map<string, string[]>;
  try {
    ({ indexId, rows, paths } = store.read((db) => ({
      indexId: (db.prepare("SELECT value FROM meta WHERE key = 'index_id'").get() as unknown as { value: string } | undefined)?.value ?? null,
      rows: db
        .prepare('SELECT source_id AS sourceId, project_id AS projectId, requested_ref AS requestedRef, ref_origin AS refOrigin, commit_sha AS "commit", config_sha256 AS configSha256 FROM generation_sources WHERE generation = ? ORDER BY source_id')
        .all(generation) as unknown as { sourceId: string; projectId: string; requestedRef: string; refOrigin: string | null; commit: string; configSha256: string | null }[],
      paths: pathsBySource(db, generation),
    })));
  } finally {
    store.close();
  }
  const config: SourcesConfig | null = context.sources;
  return {
    suite: suite.suite,
    kind,
    indexId,
    generation,
    sources: rows.map((row) => {
      const cfg = config?.sources.find((candidate) => candidate.id === row.sourceId);
      let worktreeClean: boolean | null = kind === 'workspace' ? true : null;
      if (kind === 'configured' && cfg) {
        try {
          worktreeClean = !isDirty(cfg.path, paths.get(row.sourceId) ?? []);
        } catch {
          worktreeClean = null;
        }
      }
      return { ...row, include: cfg?.include ?? null, exclude: cfg?.exclude ?? null, defaultKind: cfg?.defaultKind ?? null, rules: cfg?.rules ?? null, worktreeClean };
    }),
  };
}

function rankingRunOf(variant: RankingVariant, cases: readonly CaseRun[], corpora: readonly CorpusRecord[]): Record<string, unknown> {
  const sources = new Map<string, { sourceId: string; commit: string; worktreeClean: boolean | null }>();
  for (const corpus of corpora) for (const source of corpus.sources) sources.set(`${source.sourceId}@${source.commit}`, { sourceId: source.sourceId, commit: source.commit, worktreeClean: source.worktreeClean });
  return {
    schema: 'agent-knowledge.ranking-run',
    schemaVersion: 1,
    system: { name: PACKAGE_NAME, version: PACKAGE_VERSION, variant: variant.id, ranker: variant.request.ranker ?? 'legacy', segments: variant.request.segments === true },
    corpus: { sources: [...sources.values()].sort((a, b) => compareStrings(a.sourceId, b.sourceId) || compareStrings(a.commit, b.commit)) },
    cases: cases.map(({ result, requests }) => ({
      suite: result.suite,
      id: result.id,
      input: requests.direct,
      budget: requests.context.budget ?? null,
      ranked: (result.direct?.ranked ?? []).map((entry) => ({ path: entry.path, startLine: entry.startLine, endLine: entry.endLine, sourceId: entry.sourceId, itemId: entry.id, segmentId: entry.segmentId, chars: null })),
      error: result.error?.code ?? null,
    })),
  };
}

function reviewQueueOf(runs: readonly CaseRun[]): Record<string, unknown> {
  return {
    schema: 'agent-knowledge.review-queue',
    schemaVersion: 1,
    note: REVIEW_NOTE,
    cases: runs
      .filter(({ result }) => result.judgment === 'provisional')
      .map(({ result, requests }) => ({
        suite: result.suite,
        id: result.id,
        request: requests.direct,
        answers: result.answers,
        top: result.direct?.ranked ?? [],
        missing: result.answers.filter((answer) => answer.directRank === null).map((answer) => answer.key),
      })),
  };
}

function prepareRecordDir(dir: string): string {
  const path = resolve(dir);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || readdirSync(path).length > 0)) throw new KnowledgeError('eval-failed', `기록 디렉터리가 비어 있지 않습니다: ${path}`, { reason: 'record-dir-not-empty', path });
  mkdirSync(path, { recursive: true });
  return path;
}

export function runRanking(options: RankingOptions): { evaluation: RankingEvaluation; write: (results: unknown) => void } {
  const recordDir = options.recordDir === undefined ? undefined : prepareRecordDir(options.recordDir);
  const startedAt = new Date().toISOString();
  const contexts = new Map<RankingSuite, SuiteContext>();
  const contextOf = (suite: RankingSuite): SuiteContext => {
    let found = contexts.get(suite);
    if (!found) {
      found = options.contextOf(suite);
      contexts.set(suite, found);
    }
    return found;
  };

  const runsByVariant = new Map<string, CaseRun[]>();
  const corpora = new Map<string, CorpusRecord>();
  const variantResults = options.variants.variants.map((variant) => {
    options.progress(`순위 평가 변형을 실행합니다: ${variant.id}`);
    const suites = options.suites.map((suite) => {
      const suiteContext = contextOf(suite);
      const runs = suite.cases.map((testCase) => runCase(suiteContext.context, suite, testCase, variant));
      const generation = runs.find((run) => run.generation !== null)?.generation ?? null;
      if (generation !== null && !corpora.has(`${suite.suite}@${generation}`)) corpora.set(`${suite.suite}@${generation}`, corpusOf(suite, suiteContext, generation));
      runsByVariant.set(variant.id, [...(runsByVariant.get(variant.id) ?? []), ...runs]);
      for (const { result } of runs) if (result.error) options.progress(`오류: ${variant.id} ${suite.suite}/${result.id} ${result.error.code}: ${result.error.message}`);
      const cases = runs.map((run) => run.result);
      return { suite: suite.suite, profile: suite.profile, corpus: suite.corpus, judgments: suite.judgments, file: suite.file, metrics: metricsOf(cases), cases };
    });
    return {
      id: variant.id,
      description: variant.description,
      ranker: variant.request.ranker ?? ('legacy' as const),
      rankerVersion: RANKER_VERSIONS[variant.request.ranker ?? 'legacy'],
      segments: variant.request.segments === true,
      flatKindWeights: variant.flatKindWeights,
      configHash: { master: configHashOf(variant.retrieval, 'master'), code: configHashOf(variant.retrieval, 'code') },
      metrics: metricsOf(suites.flatMap((suite) => suite.cases)),
      suites,
    };
  });

  const base = variantResults.find((variant) => variant.id === options.variants.baseline)!;
  const baseCases = base.suites.flatMap((suite) => suite.cases);
  const comparisons = variantResults
    .filter((variant) => variant !== base)
    .map((variant) => {
      const cases = variant.suites.flatMap((suite) => suite.cases);
      const tally = { better: 0, worse: 0, same: 0 };
      cases.forEach((result, index) => {
        const order = sameAs(result.direct, baseCases[index]?.direct ?? null);
        tally[order > 0 ? 'better' : order < 0 ? 'worse' : 'same']++;
      });
      return {
        variant: variant.id,
        against: base.id,
        direct: {
          recallAt5: delta(variant.metrics.direct.all.recallAt5, base.metrics.direct.all.recallAt5),
          recallAt10: delta(variant.metrics.direct.all.recallAt10, base.metrics.direct.all.recallAt10),
          mrrAt10: delta(variant.metrics.direct.all.mrrAt10, base.metrics.direct.all.mrrAt10),
        },
        context: { requiredCoverage: delta(variant.metrics.context.requiredCoverage, base.metrics.context.requiredCoverage) },
        cases: tally,
      };
    });

  const corpusList = [...corpora.values()].sort((a, b) => compareStrings(a.suite, b.suite) || a.generation - b.generation);
  const baselines = options.baselines.map((file): BaselineReport => {
    const path = resolve(file);
    const { run, sha256: digest } = loadRankingRun(path);
    const ours = new Map<string, string>();
    for (const corpus of corpusList) for (const source of corpus.sources) ours.set(source.sourceId, source.commit);
    // 상대가 어떤 커밋을 봤는지 적지 않은 원본도 같은 자료를 봤다고 할 수 없으므로 불일치로 센다
    const theirs = new Map(run.corpus.sources.map((source) => [source.sourceId, source.commit]));
    const mismatches = [
      ...run.corpus.sources.filter((source) => ours.get(source.sourceId) !== source.commit).map((source) => ({ sourceId: source.sourceId, ours: ours.get(source.sourceId) ?? null, theirs: source.commit as string | null })),
      ...[...ours.keys()].filter((sourceId) => !theirs.has(sourceId)).map((sourceId) => ({ sourceId, ours: ours.get(sourceId) ?? null, theirs: null })),
    ].sort((a, b) => compareStrings(a.sourceId, b.sourceId));
    const byCase = new Map(run.cases.map((entry) => [`${entry.suite}/${entry.id}`, entry]));
    const baseRuns = runsByVariant.get(base.id) ?? [];
    const shared = baseRuns.filter(({ result }) => result.error === null && byCase.has(`${result.suite}/${result.id}`));
    return {
      file: path,
      sha256: digest,
      system: { name: run.system.name, version: run.system.version ?? null },
      corpus: { matches: mismatches.length === 0, mismatches },
      missingCases: baseRuns.filter(({ result }) => !byCase.has(`${result.suite}/${result.id}`)).map(({ result }) => `${result.suite}/${result.id}`),
      metrics: overlapAggregate(shared.map(({ result, answers }) => overlapScore(byCase.get(`${result.suite}/${result.id}`)!.ranked, answers))),
      ours: variantResults.map((variant) => {
        const runs = (runsByVariant.get(variant.id) ?? []).filter(({ result }) => result.error === null && byCase.has(`${result.suite}/${result.id}`));
        return { variant: variant.id, metrics: overlapAggregate(runs.map(({ result, answers }) => overlapScore(result.direct?.ranked ?? [], answers))) };
      }),
    };
  });

  const files = recordDir === undefined ? [] : ['manifest.json', 'results.json', 'review-queue.json', ...variantResults.map((variant) => `ranking-run.${variant.id}.json`)];
  const evaluation: RankingEvaluation = {
    baselineVariant: base.id,
    variants: variantResults,
    comparisons,
    baselines,
    corpora: corpusList,
    record: recordDir === undefined ? null : { dir: recordDir, files },
  };

  const write = (results: unknown): void => {
    if (recordDir === undefined) return;
    const json = (name: string, value: unknown): void => writeFileSync(join(recordDir, name), `${JSON.stringify(value, null, 2)}\n`);
    json('manifest.json', {
      schema: 'agent-knowledge.eval-record',
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      package: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
      versions: { parser: PARSER_VERSION, chunker: CHUNKER_VERSION, tokenizer: TOKENIZER_VERSION, resolver: RESOLVER_VERSION, query: QUERY_VERSION, rankers: RANKER_VERSIONS },
      suites: options.suites.map((suite) => ({ file: suite.file, sha256: suite.sha256, suite: suite.suite, profile: suite.profile, corpus: suite.corpus, judgments: suite.judgments, cases: suite.cases.length })),
      variants: options.variants.variants.map((variant) => ({
        id: variant.id,
        description: variant.description,
        request: variant.request,
        retrievalConfig: { path: variant.retrievalConfigPath, sha256: variant.retrievalConfigSha256, flatKindWeights: variant.flatKindWeights },
        configHash: { master: configHashOf(variant.retrieval, 'master'), code: configHashOf(variant.retrieval, 'code') },
      })),
      variantsFile: options.variants.file,
      baselines: baselines.map((baseline) => ({ file: baseline.file, sha256: baseline.sha256, system: baseline.system })),
      corpora: corpusList,
    });
    json('results.json', results);
    json('review-queue.json', reviewQueueOf(runsByVariant.get(base.id) ?? []));
    for (const variant of options.variants.variants) json(`ranking-run.${variant.id}.json`, rankingRunOf(variant, runsByVariant.get(variant.id) ?? [], corpusList));
  };
  return { evaluation, write };
}
