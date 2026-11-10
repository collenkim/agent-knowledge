import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { COMMANDS } from '../src/cli/args.js';
import { DIRECT_K } from '../src/evaluation/ranking.js';
import { insideRepositoryEvals, loadRankingSuite, loadVariants } from '../src/evaluation/ranking-suite.js';
import { runEvaluation } from '../src/evaluation/runner.js';
import {
  capabilitiesOf,
  configHashOf,
  EXIT_CODES,
  KnowledgeError,
  LEASE_TTL_SECONDS,
  loadRetrievalConfig,
  MAX_LIVE_LEASES,
  MAX_REFERENCES,
  MIN_READABLE_SCHEMA,
  openKnowledgeBase,
  RANKER_VERSIONS,
  SCHEMA_VERSION,
  type ErrorCode,
  type RetrievalConfig,
  type RetrievalContext,
} from '../src/index.js';
import { RESOLVER_VERSION } from '../src/parsing/versions.js';
import { compareStrings } from '../src/util/compare.js';
import { git, knowledgeFixture, RETRIEVAL_CONFIG_PATH, TempSpace, tempSpace } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RANKING_SUITES = join(PACKAGE_ROOT, 'evals', 'ranking');
const VARIANTS_FILE = join(PACKAGE_ROOT, 'evals', 'ranking-variants.yaml');
const RANKING_WORKSPACE = join(PACKAGE_ROOT, 'evals', 'fixtures', 'ranking-workspace');
const VARIANT_IDS = ['legacy', 'legacy-flat-kinds', 'legacy-segments', 'bm25', 'bm25-flat-kinds', 'bm25-segments'];

const POL1 = 'rank-auth:docs/auth-policies.md#AUTH-POL-001';
const POL2 = 'rank-auth:docs/auth-policies.md#AUTH-POL-002';
const POL3 = 'rank-auth:docs/auth-policies.md#AUTH-POL-003';

/** 순위 평가 fixture를 색인한 세대의 항목 전부다. */
const ALL_ITEMS = [
  'rank-auth:docs/api-catalog.md#API-AUTH-01',
  'rank-auth:docs/api-catalog.md#API-AUTH-02',
  'rank-auth:docs/api-catalog.md#API-AUTH-03',
  'rank-auth:docs/api-catalog.md#인증-api-목록',
  POL1,
  POL2,
  POL3,
  'rank-auth:docs/auth-policies.md#AUTH-POL-004',
  'rank-auth:docs/auth-policies.md#인증-정책',
  'rank-auth:docs/token-guide.md#토큰-수명-주기',
  'rank-auth:docs/token-guide.md#토큰-오류-응답',
  'rank-auth:docs/token-guide.md#토큰-운영-안내',
  'rank-billing:docs/billing-architecture.md#모듈-구성',
  'rank-billing:docs/billing-architecture.md#정산-배치-구성',
  'rank-billing:docs/billing-architecture.md#청구-시스템-구조',
  'rank-billing:docs/billing-architecture.md#청구서-모듈',
  'rank-billing:docs/billing-rules.md#BIL-001',
  'rank-billing:docs/billing-rules.md#BIL-002',
  'rank-billing:docs/billing-rules.md#BIL-003',
  'rank-billing:docs/billing-rules.md#BIL-004',
  'rank-billing:docs/billing-rules.md#BIL-005',
  'rank-billing:docs/billing-rules.md#BIL-006',
  'rank-billing:docs/billing-rules.md#청구-업무-규칙',
  'rank-billing:docs/glossary.md#결제-수단-토큰',
  'rank-billing:docs/glossary.md#일할-계산',
  'rank-billing:docs/glossary.md#정산',
  'rank-billing:docs/glossary.md#청구-용어',
];

type Doc = Record<string, any>;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  doc: Doc;
}

/** 성공과 실패를 가리지 않고 stdout 전체가 JSON 문서 하나여야 한다. */
function run(args: readonly string[]): Run {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_KNOWLEDGE_')));
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.endsWith('\n'), true, `stdout must end with a newline: ${result.stdout}`);
  assert.equal(result.stdout.trimEnd().includes('\n'), false, `expected one line: ${result.stdout}`);
  return { status: result.status!, stdout: result.stdout, stderr: result.stderr, doc: JSON.parse(result.stdout) as Doc };
}

function assertFailure(result: Run, code: ErrorCode, command: string): Doc {
  assert.equal(result.doc.schema, 'agent-knowledge.error', result.stdout);
  assert.equal(result.doc.ok, false);
  assert.equal(result.doc.command, command);
  assert.equal(result.doc.error.code, code, result.stdout);
  assert.equal(result.status, EXIT_CODES[code], result.stdout);
  return result.doc.error.detail as Doc;
}

function caught(fn: () => unknown): KnowledgeError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KnowledgeError) return error;
    throw error;
  }
  assert.fail('expected a KnowledgeError');
}

function assertEvalFailed(fn: () => unknown, reason: string): Doc {
  const error = caught(fn);
  assert.equal(error.code, 'eval-failed', error.message);
  const detail = error.detail as Doc;
  assert.equal(detail.reason, reason, JSON.stringify(detail));
  return detail;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function readJson(path: string): Doc {
  return JSON.parse(readFileSync(path, 'utf8')) as Doc;
}

function writeYaml(path: string, value: unknown): string {
  writeFileSync(path, stringify(value));
  return path;
}

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function evaluate(options: { suitePaths: string[]; configuredContext?: () => RetrievalContext; variantsPath?: string; recordDir?: string; baselines?: string[]; responseVersion?: 1 | 2 }): Doc {
  const { configuredContext, ...rest } = options;
  return runEvaluation({
    retrievalConfigPath: RETRIEVAL_CONFIG_PATH,
    configuredContext: configuredContext ?? (() => assert.fail('workspace suites must not use the configured index')),
    progress: () => {},
    ...rest,
  }) as unknown as Doc;
}

function casesOf(variant: Doc): Doc[] {
  return variant.suites.flatMap((suite: Doc) => suite.cases as Doc[]);
}

function caseOf(variant: Doc, id: string): Doc {
  const found = casesOf(variant).find((result) => result.id === id);
  assert.ok(found, `case ${id} missing`);
  return found;
}

/** 문서에 적힌 지표 정의대로 사례 하나의 숫자를 다시 계산해 맞춰 본다. */
function assertCaseConsistent(result: Doc, label: string): void {
  assert.equal(result.error, null, label);
  const { direct, context, answers, composition } = result;
  assert.ok(direct.ranked.length <= DIRECT_K, label);
  assert.deepEqual(direct.ranked.map((entry: Doc) => entry.rank), direct.ranked.map((_: unknown, index: number) => index + 1), label);
  const ranks = (answers as Doc[]).map((answer) => answer.directRank as number | null).filter((rank): rank is number => rank !== null);
  // 결과 하나는 정답 하나만 채운다
  assert.equal(new Set(ranks).size, ranks.length, label);
  for (const answer of answers as Doc[]) if (answer.directRank !== null) assert.equal(direct.ranked[answer.directRank - 1].id, answer.key, label);
  const within = (k: number): number => ranks.filter((rank) => rank <= k).length;
  assert.equal(direct.recallAt5, round(within(5) / answers.length), label);
  assert.equal(direct.recallAt10, round(within(10) / answers.length), label);
  assert.equal(direct.hitAt5, within(5) > 0 ? 1 : 0, label);
  assert.equal(direct.hitAt10, within(10) > 0 ? 1 : 0, label);
  assert.equal(direct.reciprocalRank, ranks.length === 0 ? 0 : round(1 / Math.min(...ranks)), label);
  const required = (answers as Doc[]).filter((answer) => answer.required);
  assert.equal(context.requiredTotal, required.length, label);
  assert.equal(context.requiredFound, required.filter((answer) => answer.contextGroup !== null).length, label);
  assert.deepEqual(context.missing, required.filter((answer) => answer.contextGroup === null).map((answer) => answer.key), label);
  assert.equal(context.coverage, required.length === 0 ? null : round(context.requiredFound / required.length), label);
  const total = (histogram: Record<string, number>): number => Object.values(histogram).reduce((sum, count) => sum + count, 0);
  assert.equal(total(composition.byKind), direct.ranked.length, label);
  assert.equal(total(composition.byProject), direct.ranked.length, label);
  const keys = Object.keys(composition.byKind);
  assert.deepEqual(keys, [...keys].sort(compareStrings), label);
  assert.equal(composition.maxProjectShare, direct.ranked.length === 0 ? null : round(Math.max(...Object.values(composition.byProject as Record<string, number>)) / direct.ranked.length), label);
}

/** 직접 상위 10개에 없고 문맥에 필수·의존·연결 묶음으로만 들어온 required 정답 수. 문맥의 direct 묶음으로 들어온 정답은 세지 않는다. */
function supplementaryOnly(result: Doc): number {
  return (result.answers as Doc[]).filter((answer) => answer.required && answer.directRank === null && ['mandatory', 'dependencies', 'linked'].includes(answer.contextGroup)).length;
}

function assertAggregates(variant: Doc): void {
  const cases = casesOf(variant);
  const { metrics } = variant;
  assert.equal(metrics.cases, cases.length);
  const direct = (subset: Doc[]): Doc => ({
    cases: subset.length,
    recallAt5: mean(subset.map((result) => result.direct.recallAt5)),
    recallAt10: mean(subset.map((result) => result.direct.recallAt10)),
    mrrAt10: mean(subset.map((result) => result.direct.reciprocalRank)),
    hitAt5: mean(subset.map((result) => result.direct.hitAt5)),
    hitAt10: mean(subset.map((result) => result.direct.hitAt10)),
  });
  assert.deepEqual(metrics.direct.all, direct(cases));
  assert.deepEqual(metrics.direct.singleAnswer, direct(cases.filter((result) => result.answers.length === 1)));
  assert.deepEqual(metrics.direct.multiAnswer, direct(cases.filter((result) => result.answers.length > 1)));
  assert.equal(metrics.context.requiredCoverage, mean(cases.flatMap((result) => (result.context.coverage === null ? [] : [result.context.coverage]))));
  assert.equal(metrics.context.foundBySupplementaryOnly, cases.reduce((sum, result) => sum + result.context.foundBySupplementaryOnly, 0));
  assert.equal(metrics.unresolvedAnswers, cases.reduce((sum, result) => sum + result.answers.filter((answer: Doc) => answer.unresolved).length, 0));
  assert.equal(metrics.judgments.provisional + metrics.judgments.reviewed, cases.length);
  for (const latency of [metrics.latencyMs.direct, metrics.latencyMs.context]) assert.ok(latency.p50 <= latency.p95 && latency.p95 <= latency.max, JSON.stringify(latency));
}

function assertComparisons(ranking: Doc): void {
  const base = ranking.variants.find((variant: Doc) => variant.id === ranking.baselineVariant);
  const baseCases = casesOf(base);
  assert.deepEqual(
    ranking.comparisons.map((comparison: Doc) => comparison.variant),
    ranking.variants.filter((variant: Doc) => variant !== base).map((variant: Doc) => variant.id),
  );
  for (const comparison of ranking.comparisons as Doc[]) {
    const variant = ranking.variants.find((candidate: Doc) => candidate.id === comparison.variant);
    assert.equal(comparison.against, base.id);
    for (const metric of ['recallAt5', 'recallAt10', 'mrrAt10']) assert.equal(comparison.direct[metric], round(variant.metrics.direct.all[metric] - base.metrics.direct.all[metric]), `${comparison.variant} ${metric}`);
    assert.equal(comparison.context.requiredCoverage, round(variant.metrics.context.requiredCoverage - base.metrics.context.requiredCoverage));
    const tally = { better: 0, worse: 0, same: 0 };
    casesOf(variant).forEach((result, index) => {
      const other = baseCases[index]!;
      assert.equal(result.id, other.id);
      const order = Math.sign(result.direct.recallAt10 - other.direct.recallAt10) || Math.sign(result.direct.reciprocalRank - other.direct.reciprocalRank);
      tally[order > 0 ? 'better' : order < 0 ? 'worse' : 'same']++;
    });
    assert.deepEqual(comparison.cases, tally, comparison.variant);
  }
}

/** 평가 실행마다 달라지는 값(시간)을 뺀다. 나머지는 같은 fixture면 같아야 한다. */
function withoutTimings(ranking: Doc): Doc {
  return ranking.variants.map((variant: Doc) => ({
    id: variant.id,
    configHash: variant.configHash,
    metrics: { ...variant.metrics, latencyMs: null },
    cases: casesOf(variant).map((result) => ({ ...result, timings: null })),
  }));
}

function flatKindWeights(config: RetrievalConfig): RetrievalConfig {
  const profiles = Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, { ...profile, kindWeights: Object.fromEntries(Object.keys(profile.kindWeights).map((kind) => [kind, 1])) }]));
  return { ...config, profiles } as RetrievalConfig;
}

function rankingRun(cases: object[], sources: object[] = [], system: object = { name: 'other-system', version: null }): object {
  return { schema: 'agent-knowledge.ranking-run', schemaVersion: 1, system, corpus: { sources }, cases };
}

describe('capabilities', () => {
  it('describes this build without a database or source config', (t) => {
    const space = tempSpace(t);
    const db = space.path('none', 'k.sqlite');
    const result = run(['capabilities', '--db', db, '--config', space.path('none.yaml')]);
    assert.equal(result.status, 0, result.stdout);
    const { doc } = result;
    assert.equal(doc.schema, 'agent-knowledge.capabilities');
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.ok, true);
    assert.equal(doc.status, 'ok');
    assert.deepEqual(Object.keys(doc.commands), [...COMMANDS]);
    assert.deepEqual(doc.commands.search, { responseVersions: [1, 2], defaultResponseVersion: 1 });
    assert.deepEqual(doc.commands.get.responseVersions, [1, 2]);
    assert.deepEqual(doc.commands.eval.responseVersions, [1, 2]);
    for (const command of ['validate', 'capabilities', 'verify', 'lease']) assert.deepEqual(doc.commands[command].responseVersions, [1], command);
    for (const command of COMMANDS) assert.equal(doc.commands[command].defaultResponseVersion, 1, command);
    assert.deepEqual(
      doc.rankers.map((ranker: Doc) => [ranker.name, ranker.version, ranker.default]),
      [
        ['legacy', RANKER_VERSIONS.legacy, true],
        ['bm25', RANKER_VERSIONS.bm25, false],
      ],
    );
    assert.equal(doc.rankers[0].parameters, null);
    assert.deepEqual(Object.keys(doc.rankers[1].parameters).sort(compareStrings), ['b', 'fieldWeights', 'k1']);
    assert.deepEqual(doc.vector, { implemented: false, state: 'not-implemented' });
    assert.equal(doc.versions.parser, 'md-2');
    assert.equal(doc.versions.chunker, 'chunk-2');
    assert.equal(doc.versions.tokenizer, 'tok-1');
    assert.equal(doc.versions.query, 'query-2');
    assert.deepEqual(doc.index, { schemaVersion: SCHEMA_VERSION, minReadableSchemaVersion: MIN_READABLE_SCHEMA, v2RequiresSchemaVersion: SCHEMA_VERSION });
    assert.deepEqual(doc.segments, { chunkerVersion: 'chunk-2', maxChars: 1500, defaultEnabled: false });
    assert.deepEqual(doc.queryLimits, { maxQueries: 32, maxQueryChars: 4000, maxTermsPerQuery: 48, maxTotalTerms: 256 });
    assert.deepEqual(doc.budget.groups, ['mandatory', 'dependencies', 'direct', 'linked']);
    assert.deepEqual(doc.leases, { ttlSeconds: { ...LEASE_TTL_SECONDS }, maxLive: MAX_LIVE_LEASES });
    assert.deepEqual(doc.verify, { maxReferences: MAX_REFERENCES });
    const retrieval = loadRetrievalConfig(join(PACKAGE_ROOT, 'config', 'retrieval.yaml'));
    for (const profile of ['master', 'code'] as const) {
      assert.match(doc.profiles[profile].configHash, /^[0-9a-f]{64}$/);
      assert.equal(doc.profiles[profile].configHash, configHashOf(retrieval, profile));
    }
    assert.notEqual(doc.profiles.master.configHash, doc.profiles.code.configHash);
    // DB와 설정을 만들거나 열지 않는다
    assert.equal(existsSync(db), false);
    assert.equal(existsSync(space.path('none')), false);
    assert.deepEqual(capabilitiesOf(retrieval), doc);
    assert.deepEqual(openKnowledgeBase({ dbPath: db }).capabilities(), doc);
  });

  it('reflects the retrieval config it is given', (t) => {
    const space = tempSpace(t);
    const raw = parse(readFileSync(RETRIEVAL_CONFIG_PATH, 'utf8')) as Doc;
    const path = writeYaml(space.path('retrieval.yaml'), { ...raw, ranking: { ...raw.ranking, bm25: { k1: 1.5 } }, limits: { maxQueries: 8 } });
    const result = run(['capabilities', '--retrieval-config', path]);
    assert.equal(result.status, 0, result.stdout);
    const bm25 = result.doc.rankers.find((ranker: Doc) => ranker.name === 'bm25');
    assert.equal(bm25.parameters.k1, 1.5);
    assert.equal(bm25.parameters.b, 0.75);
    assert.deepEqual(result.doc.queryLimits, { maxQueries: 8, maxQueryChars: 4000, maxTermsPerQuery: 48, maxTotalTerms: 256 });
    const custom = loadRetrievalConfig(path);
    assert.equal(result.doc.profiles.master.configHash, configHashOf(custom, 'master'));
    assert.notEqual(result.doc.profiles.master.configHash, configHashOf(loadRetrievalConfig(RETRIEVAL_CONFIG_PATH), 'master'));

    assertFailure(run(['capabilities', '--retrieval-config', space.path('missing.yaml')]), 'config-invalid', 'capabilities');
  });

  it('matches the CLI: commands with only response version 1 refuse the flag', () => {
    for (const args of [['validate'], ['capabilities'], ['verify'], ['lease', 'list']]) {
      const detail = assertFailure(run([...args, '--response-version', '2']), 'usage', args[0]!);
      assert.notEqual(detail, undefined);
    }
  });
});

describe('default eval output', () => {
  let v1: Run;
  before(() => {
    v1 = run(['eval', '--quiet']);
  });

  it('keeps schemaVersion 1 and the previous key set without new options', () => {
    assert.equal(v1.status, 0, v1.stdout);
    assert.deepEqual(Object.keys(v1.doc), ['schema', 'schemaVersion', 'ok', 'status', 'summary', 'suites']);
    assert.equal(v1.doc.schema, 'agent-knowledge.eval');
    assert.equal(v1.doc.schemaVersion, 1);
    assert.equal(v1.doc.ok, true);
    assert.equal(v1.doc.status, 'passed');
    assert.deepEqual(Object.keys(v1.doc.summary), ['casesTotal', 'casesPassed', 'recallAtK', 'mrr']);
    assert.deepEqual(v1.doc.suites.map((suite: Doc) => suite.suite), ['master-sample', 'code-sample']);
    for (const suite of v1.doc.suites as Doc[]) {
      assert.deepEqual(Object.keys(suite), ['suite', 'profile', 'file', 'metrics', 'cases']);
      for (const result of suite.cases as Doc[]) assert.deepEqual(Object.keys(result), ['id', 'passed', 'failures', 'expected', 'found', 'firstRank', 'k']);
    }
  });

  it('wraps the same v1 results unchanged when response version 2 is requested', () => {
    const v2 = run(['eval', '--quiet', '--response-version', '2']);
    assert.equal(v2.status, 0, v2.stdout);
    assert.deepEqual(Object.keys(v2.doc), ['schema', 'schemaVersion', 'ok', 'status', 'summary', 'suites', 'ranking']);
    assert.equal(v2.doc.schemaVersion, 2);
    assert.equal(v2.doc.ranking, null);
    assert.deepEqual(v2.doc.summary, v1.doc.summary);
    assert.deepEqual(v2.doc.suites, v1.doc.suites);
  });
});

describe('ranking evaluation of the repository suites', () => {
  let space: TempSpace;
  let firstDir: string;
  let secondDir: string;
  let first: Run;
  let second: Run;
  let ranking: Doc;

  before(() => {
    space = new TempSpace();
    firstDir = space.path('records', 'first');
    secondDir = space.path('records', 'second');
    first = run(['eval', '--quiet', '--suite', RANKING_SUITES, '--variants', VARIANTS_FILE, '--record', firstDir]);
    ranking = first.doc.ranking as Doc;
    second = run(['eval', '--quiet', '--suite', RANKING_SUITES, '--variants', VARIANTS_FILE, '--record', secondDir, '--baseline', join(firstDir, 'ranking-run.legacy.json')]);
  });
  after(() => space?.dispose());

  it('reports schemaVersion 2 with every variant and no errors', () => {
    assert.equal(first.status, 0, first.stdout);
    assert.deepEqual(Object.keys(first.doc), ['schema', 'schemaVersion', 'ok', 'status', 'summary', 'suites', 'ranking']);
    assert.equal(first.doc.schemaVersion, 2);
    assert.equal(first.doc.ok, true);
    assert.equal(first.doc.status, 'passed');
    assert.equal(first.doc.summary, null);
    assert.deepEqual(first.doc.suites, []);
    assert.equal(ranking.baselineVariant, 'legacy');
    assert.deepEqual(ranking.variants.map((variant: Doc) => variant.id), VARIANT_IDS);
    assert.deepEqual(
      ranking.variants.map((variant: Doc) => [variant.ranker, variant.rankerVersion, variant.segments, variant.flatKindWeights]),
      [
        ['legacy', RANKER_VERSIONS.legacy, false, false],
        ['legacy', RANKER_VERSIONS.legacy, false, true],
        ['legacy', RANKER_VERSIONS.legacy, true, false],
        ['bm25', RANKER_VERSIONS.bm25, false, false],
        ['bm25', RANKER_VERSIONS.bm25, false, true],
        ['bm25', RANKER_VERSIONS.bm25, true, false],
      ],
    );
    for (const variant of ranking.variants as Doc[]) {
      assert.deepEqual(variant.suites.map((suite: Doc) => suite.suite), ['code-ranking', 'master-ranking']);
      const { metrics } = variant;
      assert.equal(metrics.errors, 0, variant.id);
      assert.equal(metrics.unresolvedAnswers, 0, variant.id);
      assert.equal(metrics.cases, 18, variant.id);
      assert.deepEqual(metrics.judgments, { provisional: 18, reviewed: 0 }, variant.id);
      for (const metric of ['recallAt5', 'recallAt10', 'mrrAt10', 'hitAt5', 'hitAt10']) {
        const value = metrics.direct.all[metric];
        assert.equal(typeof value, 'number', `${variant.id} ${metric}`);
        assert.ok(value >= 0 && value <= 1, `${variant.id} ${metric} ${value}`);
      }
    }
  });

  it('computes every case and aggregate exactly as documented', () => {
    for (const variant of ranking.variants as Doc[]) {
      for (const result of casesOf(variant)) assertCaseConsistent(result, `${variant.id}/${result.id}`);
      assertAggregates(variant);
    }
  });

  it('counts only answers brought in by mandatory, dependency or linked items as supplementary-only', () => {
    for (const variant of ranking.variants as Doc[]) for (const result of casesOf(variant)) assert.equal(result.context.foundBySupplementaryOnly, supplementaryOnly(result), `${variant.id}/${result.id}`);
  });

  it('compares every other variant against legacy', () => {
    assert.deepEqual(ranking.comparisons.map((comparison: Doc) => comparison.variant), VARIANT_IDS.slice(1));
    assertComparisons(ranking);
    for (const comparison of ranking.comparisons as Doc[]) assert.equal(comparison.cases.better + comparison.cases.worse + comparison.cases.same, 18);
  });

  it('merges an answer given by id and by location and keeps the mandatory-only case out of direct recall', () => {
    for (const variant of ranking.variants as Doc[]) {
      const dedupe = caseOf(variant, 'RM-02-login-lock-dedupe');
      assert.equal(dedupe.answers.length, 1, variant.id);
      assert.equal(dedupe.answers[0].key, POL2);
      assert.deepEqual(dedupe.answers[0].entries, [POL2, 'rank-auth:docs/auth-policies.md:19-23']);
      const mandatory = caseOf(variant, 'RM-11-mandatory-only');
      assert.equal(mandatory.direct.recallAt10, 0, variant.id);
      assert.equal(mandatory.context.coverage, 1, variant.id);
      assert.equal(mandatory.context.foundBySupplementaryOnly, 1, variant.id);
      assert.deepEqual(mandatory.context.foundByGroup, { mandatory: 1 });
    }
  });

  it('changes configHash with flat kind weights but not with request-only variants', () => {
    const retrieval = loadRetrievalConfig(join(PACKAGE_ROOT, 'config', 'retrieval.yaml'));
    const hashes = (config: RetrievalConfig): Doc => ({ master: configHashOf(config, 'master'), code: configHashOf(config, 'code') });
    const plain = hashes(retrieval);
    const flat = hashes(flatKindWeights(retrieval));
    assert.notEqual(plain.master, flat.master);
    assert.notEqual(plain.code, flat.code);
    for (const variant of ranking.variants as Doc[]) assert.deepEqual(variant.configHash, variant.flatKindWeights ? flat : plain, variant.id);
  });

  it('records the manifest, results, review queue and one ranking run per variant', () => {
    assert.deepEqual(readdirSync(firstDir).sort(compareStrings), ['manifest.json', 'results.json', 'review-queue.json', ...VARIANT_IDS.map((id) => `ranking-run.${id}.json`)].sort(compareStrings));
    assert.deepEqual(ranking.record, { dir: resolve(firstDir), files: ['manifest.json', 'results.json', 'review-queue.json', ...VARIANT_IDS.map((id) => `ranking-run.${id}.json`)] });
    assert.deepEqual(readJson(join(firstDir, 'results.json')), first.doc);

    const manifest = readJson(join(firstDir, 'manifest.json'));
    assert.equal(manifest.schema, 'agent-knowledge.eval-record');
    assert.equal(manifest.node, process.version);
    assert.deepEqual(manifest.versions, { parser: 'md-2', chunker: 'chunk-2', tokenizer: 'tok-1', resolver: RESOLVER_VERSION, query: 'query-2', rankers: RANKER_VERSIONS });
    assert.ok(Date.parse(manifest.startedAt) <= Date.parse(manifest.finishedAt));
    assert.equal(manifest.variantsFile, VARIANTS_FILE);
    assert.deepEqual(manifest.baselines, []);
    for (const suite of manifest.suites as Doc[]) assert.equal(suite.sha256, sha256(readFileSync(suite.file, 'utf8').replace(/^﻿/, '')), suite.suite);
    assert.deepEqual(manifest.suites.map((suite: Doc) => [suite.suite, suite.profile, suite.corpus, suite.judgments, suite.cases]), [
      ['code-ranking', 'code', 'synthetic', 'provisional', 7],
      ['master-ranking', 'master', 'synthetic', 'provisional', 11],
    ]);
    assert.deepEqual(manifest.variants.map((variant: Doc) => variant.id), VARIANT_IDS);
    const configPath = join(PACKAGE_ROOT, 'config', 'retrieval.yaml');
    for (const variant of manifest.variants as Doc[]) {
      const output = ranking.variants.find((candidate: Doc) => candidate.id === variant.id);
      assert.deepEqual(variant.configHash, output.configHash, variant.id);
      assert.equal(resolve(variant.retrievalConfig.path), resolve(configPath));
      assert.equal(variant.retrievalConfig.sha256, sha256(readFileSync(configPath)));
      assert.equal(variant.retrievalConfig.flatKindWeights, output.flatKindWeights);
    }
    assert.deepEqual(manifest.corpora, ranking.corpora);
    assert.deepEqual(manifest.corpora.map((corpus: Doc) => [corpus.suite, corpus.kind, corpus.generation]), [
      ['code-ranking', 'workspace', 1],
      ['master-ranking', 'workspace', 1],
    ]);
    for (const corpus of manifest.corpora as Doc[]) {
      assert.match(corpus.indexId, /^[0-9a-f]{32}$/);
      assert.deepEqual(corpus.sources.map((source: Doc) => source.sourceId), ['rank-auth', 'rank-billing']);
      for (const source of corpus.sources as Doc[]) {
        assert.match(source.commit, /^[0-9a-f]{40}$/);
        assert.deepEqual(source.include, ['docs/**/*.md']);
        assert.deepEqual(source.exclude, ['docs/decisions/**']);
        assert.equal(source.defaultKind, 'reference');
        assert.equal(source.requestedRef, 'HEAD');
        assert.equal(source.refOrigin, 'config');
        assert.equal(source.worktreeClean, true);
      }
    }
  });

  it('writes ranking runs and a review queue that use the fixed direct request', () => {
    for (const id of VARIANT_IDS) {
      const file = readJson(join(firstDir, `ranking-run.${id}.json`));
      const variant = ranking.variants.find((candidate: Doc) => candidate.id === id);
      assert.equal(file.schema, 'agent-knowledge.ranking-run');
      assert.equal(file.schemaVersion, 1);
      assert.deepEqual(file.system, { name: 'agent-knowledge', version: readJson(join(PACKAGE_ROOT, 'package.json')).version, variant: id, ranker: variant.ranker, segments: variant.segments });
      // 두 묶음이 같은 작업 공간을 쓰므로 원본은 한 번씩만 실린다
      assert.deepEqual(file.corpus.sources.map((source: Doc) => source.sourceId), ['rank-auth', 'rank-billing']);
      assert.equal(file.cases.length, 18);
      const results = casesOf(variant);
      file.cases.forEach((entry: Doc, index: number) => {
        const result = results[index]!;
        assert.equal(entry.id, result.id);
        assert.equal(entry.input.limit, DIRECT_K);
        assert.deepEqual(entry.input.include, { mandatory: false, dependencies: false, links: false });
        assert.equal(entry.input.responseVersion, 2);
        assert.equal(entry.input.ranker, variant.ranker === 'bm25' ? 'bm25' : undefined);
        assert.equal(entry.input.segments, variant.segments ? true : undefined);
        assert.equal(entry.budget, null);
        assert.equal(entry.error, null);
        assert.deepEqual(
          entry.ranked.map((ranked: Doc) => [ranked.itemId, ranked.segmentId, ranked.path, ranked.startLine, ranked.endLine, ranked.sourceId]),
          result.direct.ranked.map((ranked: Doc) => [ranked.id, ranked.segmentId, ranked.path, ranked.startLine, ranked.endLine, ranked.sourceId]),
        );
      });
    }
    const queue = readJson(join(firstDir, 'review-queue.json'));
    assert.equal(queue.schema, 'agent-knowledge.review-queue');
    const legacy = casesOf(ranking.variants[0]);
    assert.deepEqual(queue.cases.map((entry: Doc) => `${entry.suite}/${entry.id}`), legacy.map((result) => `${result.suite}/${result.id}`));
    for (const entry of queue.cases as Doc[]) assert.deepEqual(entry.missing, entry.answers.filter((answer: Doc) => answer.directRank === null).map((answer: Doc) => answer.key));
  });

  it('produces the same fixture commits, scores and ranking runs on a second run', () => {
    assert.equal(second.status, 0, second.stdout);
    const commits = (dir: string): Doc => readJson(join(dir, 'manifest.json')).corpora.map((corpus: Doc) => ({ suite: corpus.suite, sources: corpus.sources.map((source: Doc) => [source.sourceId, source.commit]) }));
    assert.deepEqual(commits(secondDir), commits(firstDir));
    assert.deepEqual(withoutTimings(second.doc.ranking), withoutTimings(ranking));
    for (const name of [...VARIANT_IDS.map((id) => `ranking-run.${id}.json`), 'review-queue.json']) {
      assert.equal(readFileSync(join(secondDir, name), 'utf8'), readFileSync(join(firstDir, name), 'utf8'), name);
    }
  });

  it('scores its own recorded ranking run as a baseline with the same numbers', () => {
    const baselineFile = join(firstDir, 'ranking-run.legacy.json');
    const [baseline] = second.doc.ranking.baselines as Doc[];
    assert.equal(second.doc.ranking.baselines.length, 1);
    assert.equal(baseline.file, resolve(baselineFile));
    assert.equal(baseline.sha256, sha256(readFileSync(baselineFile, 'utf8')));
    assert.deepEqual(baseline.system, { name: 'agent-knowledge', version: readJson(join(PACKAGE_ROOT, 'package.json')).version });
    assert.deepEqual(baseline.corpus, { matches: true, mismatches: [] });
    assert.deepEqual(baseline.missingCases, []);
    assert.deepEqual(baseline.ours.map((entry: Doc) => entry.variant), VARIANT_IDS);
    const ours = baseline.ours.find((entry: Doc) => entry.variant === 'legacy');
    assert.deepEqual(baseline.metrics, ours.metrics);
    assert.equal(baseline.metrics.cases, 18);
    const manifest = readJson(join(secondDir, 'manifest.json'));
    assert.deepEqual(manifest.baselines, [{ file: baseline.file, sha256: baseline.sha256, system: baseline.system }]);
  });

  it('refuses a record directory that is not empty or is a file', () => {
    const occupied = space.path('occupied');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'keep.txt'), 'keep\n');
    const detail = assertFailure(run(['eval', '--quiet', '--suite', RANKING_SUITES, '--record', occupied]), 'eval-failed', 'eval');
    assert.equal(detail.reason, 'record-dir-not-empty');
    assert.deepEqual(readdirSync(occupied), ['keep.txt']);
    assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'keep\n');

    const file = space.path('a-file');
    writeFileSync(file, 'x');
    assert.equal(assertFailure(run(['eval', '--quiet', '--suite', RANKING_SUITES, '--record', file]), 'eval-failed', 'eval').reason, 'record-dir-not-empty');
  });
});

describe('ranking scoring rules on a temporary suite', () => {
  let space: TempSpace;
  let output: Doc;
  let legacy: Doc;
  let small: Doc;
  let recordDir: string;

  before(() => {
    space = new TempSpace();
    const raw = parse(readFileSync(RETRIEVAL_CONFIG_PATH, 'utf8')) as Doc;
    // 기본 출력 수를 1로 줄여도 직접 순위는 항상 상위 10개를 받아야 한다
    writeYaml(space.path('small-limit.yaml'), { ...raw, profiles: { master: { ...raw.profiles.master, limit: 1 }, code: { ...raw.profiles.code, limit: 1 } } });
    const variantsPath = writeYaml(space.path('variants.yaml'), {
      schemaVersion: 1,
      baseline: 'legacy',
      variants: [{ id: 'legacy' }, { id: 'small-limit', retrieval: { config: './small-limit.yaml' } }],
    });
    const suite = writeYaml(space.path('suite.yaml'), {
      schemaVersion: 2,
      suite: 'tmp-ranking',
      profile: 'master',
      corpus: 'synthetic',
      fixture: true,
      judgments: 'provisional',
      workspace: RANKING_WORKSPACE,
      defaults: { request: { scope: { projects: ['rank-auth'] } } },
      cases: [
        {
          id: 'dedupe',
          request: { query: '로그인 연속 실패 계정 잠금' },
          relevant: [
            { id: POL2, grade: 1, required: false },
            { location: { sourceId: 'rank-auth', path: 'docs/auth-policies.md', startLine: 19, endLine: 23 }, grade: 3 },
            { location: { path: 'docs/auth-policies.md', startLine: 20, endLine: 20 } },
          ],
        },
        { id: 'dedupe-location-first', request: { query: '로그인 연속 실패 계정 잠금' }, relevant: [{ location: { path: 'docs/auth-policies.md', startLine: 18, endLine: 22 } }, { id: POL2 }] },
        { id: 'mandatory-only', request: { query: '무차별 대입 방어' }, relevant: [{ id: POL2 }] },
        { id: 'mandatory-excluded', request: { query: '무차별 대입 방어' }, relevant: [{ id: POL2 }], context: { include: { mandatory: false } } },
        { id: 'unresolved', request: { query: '비밀번호 재설정 토큰 만료' }, relevant: [{ id: POL1 }, { id: 'rank-auth:docs/none.md#missing' }, { location: { path: 'docs/none.md', startLine: 1, endLine: 2 } }] },
        {
          id: 'all-items',
          request: { query: '비밀번호 재설정 토큰 만료 시간', scope: { projects: ['rank-auth', 'rank-billing'] } },
          relevant: ALL_ITEMS.map((id) => ({ id })),
          expectKinds: ['policy', 'api-catalog', 'handoff'],
        },
        { id: 'overlap', judgment: 'reviewed', request: { query: '비밀번호 재설정 토큰 로그인 잠금' }, relevant: [{ id: POL1 }, { id: POL2 }] },
        { id: 'budget', request: { query: '비밀번호 재설정 토큰 만료' }, relevant: [{ id: POL1 }], context: { budget: { maxItems: 1 } } },
        { id: 'optional-only', request: { query: '세션 유지 시간' }, relevant: [{ id: POL3, required: false }] },
      ],
    });
    const overlapBaseline = writeJson(
      space.path('overlap-baseline.json'),
      rankingRun(
        [
          // 문서 전체를 덮는 결과 하나는 정답 둘 중 하나만 채운다
          { suite: 'tmp-ranking', id: 'overlap', ranked: [{ path: 'docs/auth-policies.md', startLine: 1, endLine: 35, sourceId: 'rank-auth' }] },
          {
            suite: 'tmp-ranking',
            id: 'mandatory-only',
            ranked: [
              { path: 'docs/auth-policies.md', startLine: 17, endLine: 23, sourceId: 'rank-billing' },
              { path: 'docs/auth-policies.md', startLine: 23, endLine: 30 },
            ],
          },
          // 11위만 겹친다. 외부 목록도 상위 10개만 센다
          {
            suite: 'tmp-ranking',
            id: 'optional-only',
            ranked: [...Array.from({ length: DIRECT_K }, (_, index) => ({ path: 'docs/token-guide.md', startLine: 41 + index, endLine: 41 + index, sourceId: 'rank-auth' })), { path: 'docs/auth-policies.md', startLine: 25, endLine: 29, sourceId: 'rank-auth' }],
          },
        ],
        [
          { sourceId: 'rank-auth', commit: 'f'.repeat(40) },
          { sourceId: 'ghost', commit: 'a'.repeat(40) },
        ],
      ),
    );
    const emptyBaseline = writeJson(space.path('empty-baseline.json'), rankingRun([]));
    recordDir = space.path('record');
    output = evaluate({ suitePaths: [suite], variantsPath, recordDir, baselines: [overlapBaseline, emptyBaseline] });
    [legacy, small] = output.ranking.variants as Doc[];
  });
  after(() => space?.dispose());

  it('runs both variants without errors and keeps every number consistent', () => {
    assert.equal(output.schemaVersion, 2);
    assert.equal(output.ok, true, JSON.stringify(output.error));
    assert.deepEqual(output.ranking.variants.map((variant: Doc) => variant.id), ['legacy', 'small-limit']);
    for (const variant of [legacy, small]) {
      assert.equal(variant.metrics.errors, 0);
      for (const result of casesOf(variant)) assertCaseConsistent(result, `${variant.id}/${result.id}`);
      assertAggregates(variant);
    }
    assertComparisons(output.ranking);
    assert.notEqual(small.configHash.master, legacy.configHash.master);
  });

  it('counts an answer given by id and by location once', () => {
    const dedupe = caseOf(legacy, 'dedupe');
    assert.equal(dedupe.answers.length, 1);
    assert.deepEqual(dedupe.answers[0], {
      key: POL2,
      entries: [POL2, 'rank-auth:docs/auth-policies.md:19-23', '*:docs/auth-policies.md:20-20'],
      // 같은 정답으로 합치면 하나라도 required면 required이고 등급은 가장 높은 값이다
      required: true,
      grade: 3,
      unresolved: false,
      directRank: dedupe.answers[0].directRank,
      contextGroup: dedupe.answers[0].contextGroup,
    });
    assert.equal(typeof dedupe.answers[0].directRank, 'number');
    assert.equal(dedupe.direct.recallAt10, 1);
    const reversed = caseOf(legacy, 'dedupe-location-first');
    assert.equal(reversed.answers.length, 1);
    assert.deepEqual(reversed.answers[0].entries, ['*:docs/auth-policies.md:18-22', POL2]);
    assert.equal(reversed.answers[0].key, POL2);
    // 합친 정답은 정답 하나짜리 사례로 센다
    assert.equal(legacy.metrics.direct.singleAnswer.cases, 6);
    assert.equal(legacy.metrics.direct.multiAnswer.cases, 3);
  });

  it('cuts the direct ranking at a fixed K of 10 and divides recall by the number of answers', () => {
    for (const variant of [legacy, small]) {
      const all = caseOf(variant, 'all-items');
      assert.equal(all.answers.length, ALL_ITEMS.length);
      assert.ok(all.direct.directMatched > DIRECT_K, `${variant.id} directMatched ${all.direct.directMatched}`);
      assert.equal(all.direct.ranked.length, DIRECT_K, variant.id);
      // 모든 항목이 정답이므로 상위 10개가 모두 맞고, 11위 이후는 세지 않는다
      assert.equal(all.direct.recallAt10, round(DIRECT_K / ALL_ITEMS.length), variant.id);
      assert.equal(all.direct.recallAt5, round(5 / ALL_ITEMS.length), variant.id);
      assert.equal(all.direct.reciprocalRank, 1);
      assert.equal(all.answers.filter((answer: Doc) => answer.directRank !== null).length, DIRECT_K);
      const unresolved = caseOf(variant, 'unresolved');
      assert.equal(unresolved.answers.length, 3);
      const found = unresolved.answers.find((answer: Doc) => answer.key === POL1);
      assert.ok(found.directRank !== null && found.directRank <= DIRECT_K);
      assert.equal(unresolved.direct.recallAt10, round(1 / 3), variant.id);
    }
    // 프로필의 limit을 1로 줄여도 직접 순위는 같다. 문맥 실행만 프로필의 limit을 따른다
    assert.deepEqual(casesOf(small).map((result) => result.direct), casesOf(legacy).map((result) => result.direct));
    const comparison = output.ranking.comparisons[0];
    assert.deepEqual(comparison.direct, { recallAt5: 0, recallAt10: 0, mrrAt10: 0 });
    assert.deepEqual(comparison.cases, { better: 0, worse: 0, same: 9 });
    assert.ok(caseOf(small, 'all-items').context.items < caseOf(legacy, 'all-items').context.items);
  });

  it('does not count an answer the context run matched directly as supplementary-only', () => {
    const all = caseOf(legacy, 'all-items');
    // 문맥 실행에서는 필수 항목이 direct 묶음을 비우므로 직접 순위 11위였던 정답이 direct 묶음으로 들어온다
    assert.ok(
      all.answers.some((answer: Doc) => answer.directRank === null && answer.contextGroup === 'direct'),
      JSON.stringify(all.answers.filter((answer: Doc) => answer.contextGroup !== null).map((answer: Doc) => [answer.key, answer.directRank, answer.contextGroup])),
    );
    for (const variant of [legacy, small]) for (const result of casesOf(variant)) assert.equal(result.context.foundBySupplementaryOnly, supplementaryOnly(result), `${variant.id}/${result.id}`);
  });

  it('measures the composition of the direct top 10', () => {
    const { composition } = caseOf(legacy, 'all-items');
    assert.equal(composition.kindCoverage, round(['policy', 'api-catalog', 'handoff'].filter((kind) => kind in composition.byKind).length / 3));
    assert.equal(composition.byKind.handoff, undefined);
    assert.equal(caseOf(legacy, 'dedupe').composition.kindCoverage, null);
    assert.equal(caseOf(legacy, 'mandatory-only').composition.maxProjectShare, null);
  });

  it('separates an answer found only through mandatory items from direct recall', () => {
    const mandatory = caseOf(legacy, 'mandatory-only');
    assert.equal(mandatory.direct.outcome, 'no-results');
    assert.equal(mandatory.direct.directMatched, 0);
    assert.deepEqual(mandatory.direct.ranked, []);
    assert.equal(mandatory.direct.recallAt5, 0);
    assert.equal(mandatory.direct.recallAt10, 0);
    assert.equal(mandatory.direct.reciprocalRank, 0);
    assert.equal(mandatory.context.coverage, 1);
    assert.equal(mandatory.context.foundBySupplementaryOnly, 1);
    assert.deepEqual(mandatory.context.foundByGroup, { mandatory: 1 });
    assert.equal(mandatory.answers[0].directRank, null);
    assert.equal(mandatory.answers[0].contextGroup, 'mandatory');

    const excluded = caseOf(legacy, 'mandatory-excluded');
    assert.equal(excluded.context.coverage, 0);
    assert.deepEqual(excluded.context.missing, [POL2]);
    assert.equal(excluded.context.foundBySupplementaryOnly, 0);
    assert.equal(excluded.answers[0].contextGroup, null);
  });

  it('counts answers that the generation does not have as unresolved', () => {
    const unresolved = caseOf(legacy, 'unresolved');
    assert.deepEqual(
      unresolved.answers.map((answer: Doc) => [answer.key, answer.unresolved, answer.directRank === null]),
      [
        [POL1, false, false],
        ['rank-auth:docs/none.md#missing', true, true],
        ['*:docs/none.md:1-2', true, true],
      ],
    );
    assert.deepEqual(unresolved.context.missing, ['rank-auth:docs/none.md#missing', '*:docs/none.md:1-2']);
    for (const variant of [legacy, small]) assert.equal(variant.metrics.unresolvedAnswers, 2, variant.id);
  });

  it('applies a case budget only to the context run and leaves optional answers out of coverage', () => {
    const budget = caseOf(legacy, 'budget');
    assert.equal(budget.direct.recallAt10, 1);
    assert.equal(budget.context.items, 1);
    assert.equal(budget.context.truncated, true);
    assert.equal(legacy.metrics.context.truncatedCases, 1);
    const optional = caseOf(legacy, 'optional-only');
    assert.equal(optional.context.requiredTotal, 0);
    assert.equal(optional.context.coverage, null);
    assert.deepEqual(optional.context.missing, []);
  });

  it('splits provisional and reviewed judgments and queues only provisional cases for review', () => {
    assert.deepEqual(legacy.metrics.judgments, { provisional: 8, reviewed: 1 });
    assert.equal(caseOf(legacy, 'overlap').judgment, 'reviewed');
    const queue = readJson(join(recordDir, 'review-queue.json'));
    assert.equal(queue.cases.length, 8);
    assert.equal(queue.cases.some((entry: Doc) => entry.id === 'overlap'), false);
    const runs = readJson(join(recordDir, 'ranking-run.legacy.json'));
    assert.deepEqual(runs.cases.find((entry: Doc) => entry.id === 'budget').budget, { maxItems: 1 });
    assert.equal(runs.cases.find((entry: Doc) => entry.id === 'dedupe').budget, null);
  });

  it('scores a baseline by location overlap, one answer per ranked entry', () => {
    const [overlap, empty] = output.ranking.baselines as Doc[];
    assert.deepEqual(overlap.system, { name: 'other-system', version: null });
    // overlap: 정답 둘 중 하나(1위), mandatory-only: 다른 원본은 겹치지 않고 원본을 적지 않은 2위가 맞는다, optional-only: 11위는 세지 않는다
    assert.deepEqual(overlap.metrics, { cases: 3, recallAt5: 0.5, recallAt10: 0.5, mrrAt10: 0.5 });
    const scored = new Set(['tmp-ranking/overlap', 'tmp-ranking/mandatory-only', 'tmp-ranking/optional-only']);
    assert.deepEqual(
      overlap.missingCases,
      casesOf(legacy)
        .map((result) => `tmp-ranking/${result.id}`)
        .filter((key) => !scored.has(key)),
    );
    assert.deepEqual(overlap.ours.map((entry: Doc) => [entry.variant, entry.metrics.cases]), [
      ['legacy', 3],
      ['small-limit', 3],
    ]);
    assert.deepEqual(empty.metrics, { cases: 0, recallAt5: null, recallAt10: null, mrrAt10: null });
    assert.equal(empty.missingCases.length, 9);
  });

  it('flags a baseline whose commits differ from the evaluated corpus or omit an evaluated source', () => {
    const [overlap] = output.ranking.baselines as Doc[];
    const commits = new Map((output.ranking.corpora[0].sources as Doc[]).map((source) => [source.sourceId, source.commit as string]));
    assert.equal(overlap.corpus.matches, false);
    // 상대가 커밋을 적지 않은 평가 원본(rank-billing)도 같은 자료를 봤다고 할 수 없으므로 불일치다. 원본 ID 순이다
    assert.deepEqual(overlap.corpus.mismatches, [
      { sourceId: 'ghost', ours: null, theirs: 'a'.repeat(40) },
      { sourceId: 'rank-auth', ours: commits.get('rank-auth'), theirs: 'f'.repeat(40) },
      { sourceId: 'rank-billing', ours: commits.get('rank-billing'), theirs: null },
    ]);
  });
});

describe('ranking suite validation', () => {
  function suiteText(overrides: Doc = {}, cases: object[] = [{ id: 'A', request: { query: '토큰' }, relevant: [{ id: POL1 }] }]): Doc {
    return { schemaVersion: 2, suite: 'tmp', profile: 'master', corpus: 'synthetic', fixture: true, judgments: 'provisional', workspace: RANKING_WORKSPACE, cases, ...overrides };
  }

  it('accepts a synthetic suite and resolves its workspace against the suite file', (t) => {
    const space = tempSpace(t);
    mkdirSync(space.path('suites'));
    const file = writeYaml(space.path('suites', 'a.yaml'), suiteText({ workspace: '../ws' }));
    const suite = loadRankingSuite(file);
    assert.equal(suite.workspace, space.path('ws'));
    assert.equal(suite.file, file);
    assert.equal(suite.sha256, sha256(readFileSync(file, 'utf8')));
  });

  it('accepts a real suite outside the repository evals directory', (t) => {
    const space = tempSpace(t);
    const { fixture: _fixture, workspace: _workspace, ...real } = suiteText({ corpus: 'real' });
    const suite = loadRankingSuite(writeYaml(space.path('real.yaml'), real));
    assert.equal(suite.corpus, 'real');
    assert.equal(suite.workspace, null);
  });

  const invalid: [string, Doc][] = [
    ['synthetic without fixture', suiteText({ fixture: undefined })],
    ['synthetic with fixture false', suiteText({ fixture: false })],
    ['synthetic without workspace', suiteText({ workspace: undefined })],
    ['real with a workspace', suiteText({ corpus: 'real', fixture: undefined })],
    ['real marked as fixture', suiteText({ corpus: 'real', workspace: undefined })],
    ['no cases', suiteText({}, [])],
    ['a case without answers', suiteText({}, [{ id: 'A', request: { query: '토큰' }, relevant: [] }])],
    ['an answer with both id and location', suiteText({}, [{ id: 'A', request: { query: '토큰' }, relevant: [{ id: POL1, location: { path: 'a.md', startLine: 1, endLine: 1 } }] }])],
    ['an unknown expected kind', suiteText({}, [{ id: 'A', request: { query: '토큰' }, relevant: [{ id: POL1 }], expectKinds: ['nope'] }])],
    ['a grade above 3', suiteText({}, [{ id: 'A', request: { query: '토큰' }, relevant: [{ id: POL1, grade: 4 }] }])],
  ];
  for (const [name, body] of invalid) {
    it(`refuses ${name}`, (t) => {
      const space = tempSpace(t);
      const file = writeYaml(space.path('suite.yaml'), JSON.parse(JSON.stringify(body)));
      assert.equal(assertEvalFailed(() => loadRankingSuite(file), 'suite-invalid').file, file);
    });
  }

  it('refuses a case or default request that sets a field the run controls', (t) => {
    const space = tempSpace(t);
    const fields: Doc = { limit: 3, include: { mandatory: false }, ranker: 'bm25', segments: true, budget: { maxItems: 1 }, responseVersion: 2, profile: 'code' };
    for (const [field, value] of Object.entries(fields)) {
      const inCase = writeYaml(space.path(`case-${field}.yaml`), suiteText({}, [{ id: 'A', request: { query: '토큰', [field]: value }, relevant: [{ id: POL1 }] }]));
      const detail = assertEvalFailed(() => loadRankingSuite(inCase), 'suite-invalid');
      assert.ok(detail.issues.some((issue: Doc) => issue.path === `cases.0.request.${field}`), `${field}: ${JSON.stringify(detail.issues)}`);
      const inDefaults = writeYaml(space.path(`defaults-${field}.yaml`), suiteText({ defaults: { request: { [field]: value } } }));
      assertEvalFailed(() => loadRankingSuite(inDefaults), 'suite-invalid');
    }
  });

  it('refuses duplicate case ids', (t) => {
    const space = tempSpace(t);
    const file = writeYaml(
      space.path('suite.yaml'),
      suiteText({}, [
        { id: 'A', request: { query: '토큰' }, relevant: [{ id: POL1 }] },
        { id: 'A', request: { query: '잠금' }, relevant: [{ id: POL2 }] },
      ]),
    );
    const detail = assertEvalFailed(() => loadRankingSuite(file), 'suite-invalid');
    assert.ok(detail.issues.some((issue: Doc) => issue.path === 'cases.1.id'), JSON.stringify(detail.issues));
  });

  it('reports a broken ranking suite through the CLI as eval-failed', (t) => {
    const space = tempSpace(t);
    const file = writeYaml(space.path('suite.yaml'), JSON.parse(JSON.stringify(suiteText({ fixture: undefined }))));
    const detail = assertFailure(run(['eval', '--quiet', '--suite', file]), 'eval-failed', 'eval');
    assert.equal(detail.reason, 'suite-invalid');
  });

  it('keeps the previous message and file order for suites that are not valid YAML', (t) => {
    const space = tempSpace(t);
    const broken = space.path('b.yaml');
    writeFileSync(broken, 'cases: [\n');
    const single = run(['eval', '--quiet', '--suite', broken]);
    assert.equal(assertFailure(single, 'eval-failed', 'eval').reason, 'suite-invalid');
    assert.equal(single.doc.error.message.startsWith('평가 묶음을 읽을 수 없습니다: '), true, single.doc.error.message);
    // 앞 파일의 형식 오류가 뒤 파일의 YAML 오류보다 먼저 보고된다
    mkdirSync(space.path('dir'));
    writeYaml(space.path('dir', 'a.yaml'), { suite: 'a', cases: [] });
    writeFileSync(space.path('dir', 'b.yaml'), 'cases: [\n');
    const ordered = run(['eval', '--quiet', '--suite', space.path('dir')]);
    assert.equal(assertFailure(ordered, 'eval-failed', 'eval').file, space.path('dir', 'a.yaml'));
    assert.equal(ordered.doc.error.message.startsWith('평가 묶음의 형식이 올바르지 않습니다: '), true, ordered.doc.error.message);
  });

  it('treats names inside evals that start with two dots as inside the repository', () => {
    const evals = join(PACKAGE_ROOT, 'evals');
    for (const path of [join(evals, '..real.yaml'), join(evals, '..private', 'real.yaml'), join(evals, 'ranking', 'real.yaml')]) assert.equal(insideRepositoryEvals(path), true, path);
    for (const path of [evals, join(evals, '..', 'real.yaml'), join(PACKAGE_ROOT, 'real.yaml'), resolve(PACKAGE_ROOT, '..', 'evals', 'real.yaml')]) assert.equal(insideRepositoryEvals(path), false, path);
  });
});

describe('ranking variants file', () => {
  function variantsFile(path: string, body: object): string {
    return writeYaml(path, { schemaVersion: 1, ...body });
  }

  it('falls back to one default variant without a file', () => {
    const variants = loadVariants(undefined, RETRIEVAL_CONFIG_PATH);
    assert.equal(variants.file, null);
    assert.equal(variants.baseline, 'default');
    assert.deepEqual(variants.variants.map((variant) => [variant.id, variant.flatKindWeights, variant.request]), [['default', false, {}]]);
  });

  it('defaults the baseline to the first variant and resolves configs next to the file', (t) => {
    const space = tempSpace(t);
    mkdirSync(space.path('nested'));
    const raw = parse(readFileSync(RETRIEVAL_CONFIG_PATH, 'utf8')) as Doc;
    writeYaml(space.path('nested', 'other.yaml'), { ...raw, profiles: { ...raw.profiles, master: { ...raw.profiles.master, limit: 3 } } });
    const file = variantsFile(space.path('nested', 'variants.yaml'), { variants: [{ id: 'b' }, { id: 'a', retrieval: { config: 'other.yaml' } }] });
    const variants = loadVariants(file, RETRIEVAL_CONFIG_PATH);
    assert.equal(variants.baseline, 'b');
    assert.equal(variants.variants[0]!.retrievalConfigPath, RETRIEVAL_CONFIG_PATH);
    assert.equal(variants.variants[1]!.retrievalConfigPath, space.path('nested', 'other.yaml'));
    assert.equal(variants.variants[1]!.retrieval.profiles.master.limit, 3);
  });

  it('sets only kind weights to 1 for flatKindWeights and changes the config hash', (t) => {
    const space = tempSpace(t);
    const file = variantsFile(space.path('variants.yaml'), { variants: [{ id: 'plain' }, { id: 'flat', retrieval: { flatKindWeights: true } }] });
    const [plain, flat] = loadVariants(file, RETRIEVAL_CONFIG_PATH).variants;
    for (const profile of ['master', 'code'] as const) {
      assert.ok(Object.values(flat!.retrieval.profiles[profile].kindWeights).every((value) => value === 1), profile);
      assert.deepEqual(Object.keys(flat!.retrieval.profiles[profile].kindWeights), Object.keys(plain!.retrieval.profiles[profile].kindWeights));
      assert.deepEqual(flat!.retrieval.profiles[profile].phaseWeights, plain!.retrieval.profiles[profile].phaseWeights);
      assert.notEqual(configHashOf(flat!.retrieval, profile), configHashOf(plain!.retrieval, profile));
    }
    assert.deepEqual(flat!.retrieval.ranking, plain!.retrieval.ranking);
    assert.equal(flat!.retrievalConfigSha256, plain!.retrievalConfigSha256);
  });

  const invalid: [string, object][] = [
    ['duplicate ids', { variants: [{ id: 'a' }, { id: 'a' }] }],
    ['an unknown baseline', { baseline: 'missing', variants: [{ id: 'a' }] }],
    ['an id with capitals', { variants: [{ id: 'Legacy' }] }],
    ['a request field other than ranker, segments and quota', { variants: [{ id: 'a', request: { limit: 3 } }] }],
    ['no variants', { variants: [] }],
  ];
  for (const [name, body] of invalid) {
    it(`refuses ${name}`, (t) => {
      const space = tempSpace(t);
      const file = variantsFile(space.path('variants.yaml'), body);
      assert.equal(assertEvalFailed(() => loadVariants(file, RETRIEVAL_CONFIG_PATH), 'variants-invalid').file, file);
    });
  }

  it('reports a variants file that is not valid YAML as variants-invalid', (t) => {
    const space = tempSpace(t);
    const file = space.path('variants.yaml');
    writeFileSync(file, 'schemaVersion: 1\nvariants: [\n');
    assertEvalFailed(() => loadVariants(file, RETRIEVAL_CONFIG_PATH), 'variants-invalid');
  });

  it('reports variants problems through the CLI before running anything', (t) => {
    const space = tempSpace(t);
    const duplicate = variantsFile(space.path('dup.yaml'), { variants: [{ id: 'a' }, { id: 'a' }] });
    const detail = assertFailure(run(['eval', '--quiet', '--suite', RANKING_SUITES, '--variants', duplicate, '--record', space.path('rec')]), 'eval-failed', 'eval');
    assert.equal(detail.reason, 'variants-invalid');
    assert.ok(detail.issues.some((issue: Doc) => issue.path === 'variants.1.id'), JSON.stringify(detail.issues));
    const unknown = variantsFile(space.path('unknown.yaml'), { baseline: 'nope', variants: [{ id: 'a' }] });
    assert.equal(assertFailure(run(['eval', '--quiet', '--suite', RANKING_SUITES, '--variants', unknown]), 'eval-failed', 'eval').reason, 'variants-invalid');
    assert.equal(existsSync(space.path('rec')), false);
  });
});

describe('mixed v1 and v2 suites', () => {
  it('keeps the v1 results unchanged next to the ranking results', (t) => {
    const space = tempSpace(t);
    const tiny = writeYaml(space.path('tiny.yaml'), {
      schemaVersion: 2,
      suite: 'tiny',
      profile: 'master',
      corpus: 'synthetic',
      fixture: true,
      judgments: 'provisional',
      workspace: RANKING_WORKSPACE,
      cases: [{ id: 'T-1', request: { query: '환불 처리 기한', scope: { projects: ['rank-billing'] } }, relevant: [{ id: 'rank-billing:docs/billing-rules.md#BIL-004' }] }],
    });
    const master = join(PACKAGE_ROOT, 'evals', 'master');
    const alone = evaluate({ suitePaths: [master] });
    const mixed = evaluate({ suitePaths: [master, tiny], recordDir: space.path('rec') });
    assert.equal(alone.schemaVersion, 1);
    assert.equal(mixed.schemaVersion, 2);
    assert.equal(mixed.ok, true, JSON.stringify(mixed.error));
    assert.deepEqual(mixed.summary, alone.summary);
    assert.deepEqual(mixed.suites, alone.suites);
    assert.deepEqual(mixed.ranking.variants.map((variant: Doc) => variant.id), ['default']);
    assert.deepEqual(mixed.ranking.variants[0].suites.map((suite: Doc) => suite.suite), ['tiny']);
    const manifest = readJson(space.path('rec', 'manifest.json'));
    assert.deepEqual(manifest.suites.map((suite: Doc) => suite.suite), ['tiny']);
    assert.equal(manifest.variantsFile, null);
    assert.deepEqual(readJson(space.path('rec', 'results.json')).suites, alone.suites);
  });
});

describe('ranking options without ranking suites', () => {
  const V1_SUITES = [join(PACKAGE_ROOT, 'evals', 'master'), join(PACKAGE_ROOT, 'evals', 'code')];

  it('refuses --variants, --record and --baseline when only v1 suites are loaded', (t) => {
    const space = tempSpace(t);
    const record = space.path('rec');
    for (const option of [{ variantsPath: VARIANTS_FILE }, { recordDir: record }, { baselines: [space.path('none.json')] }]) {
      const detail = assertEvalFailed(() => evaluate({ suitePaths: V1_SUITES, ...option }), 'no-ranking-suites');
      assert.deepEqual(detail.suites, [join(PACKAGE_ROOT, 'evals', 'master', 'master-sample.yaml'), join(PACKAGE_ROOT, 'evals', 'code', 'code-sample.yaml')]);
    }
    assert.equal(existsSync(record), false);
  });

  it('refuses them on the default CLI suites too', (t) => {
    const space = tempSpace(t);
    const record = space.path('rec');
    assert.equal(assertFailure(run(['eval', '--quiet', '--variants', VARIANTS_FILE]), 'eval-failed', 'eval').reason, 'no-ranking-suites');
    assert.equal(assertFailure(run(['eval', '--quiet', '--record', record]), 'eval-failed', 'eval').reason, 'no-ranking-suites');
    assert.equal(existsSync(record), false);
  });
});

describe('ranking evaluation against a configured index', () => {
  const DOC = '---\nkind: policy\n---\n# 배송 정책\n\n배송 본문이다.\n\n### `BR-001` 배송 기한\n\n주문 후 3일 안에 배송한다.\n';

  const R1 = { id: 'R-1', request: { query: '배송 기한', scope: { projects: ['orders'] } }, relevant: [{ id: 'orders:docs/a.md#BR-001' }] };

  function setup(t: TestContext, cases: object[] = [R1]): { fixture: ReturnType<typeof knowledgeFixture>; suite: string } {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: { 'docs/a.md': DOC } }]);
    fixture.index();
    const suite = writeYaml(fixture.space.path('real.yaml'), { schemaVersion: 2, suite: 'real-orders', profile: 'master', corpus: 'real', judgments: 'reviewed', cases });
    return { fixture, suite };
  }

  it('records a case that cannot run as an error and fails the evaluation', (t) => {
    const { fixture, suite } = setup(t, [R1, { ...R1, id: 'R-2', request: { query: '배송 기한', scope: { projects: ['nope'] } } }]);
    const record = fixture.space.path('rec');
    // 비어 있는 디렉터리는 기록 대상으로 받는다
    mkdirSync(record);
    const output = evaluate({ suitePaths: [suite], configuredContext: () => fixture.context, recordDir: record });
    assert.equal(output.ok, false);
    assert.equal(output.status, 'failed');
    assert.equal(output.error.code, 'eval-failed');
    assert.deepEqual(output.error.detail, { legacyFailed: 0, rankingErrors: 1 });
    const [variant] = output.ranking.variants as Doc[];
    assert.equal(variant!.metrics.errors, 1);
    assert.equal(variant!.metrics.cases, 2);
    assert.equal(variant!.metrics.direct.all.cases, 1);
    const failed = caseOf(variant!, 'R-2');
    assert.equal(failed.error.code, 'invalid-scope');
    assert.equal(failed.direct, null);
    assert.equal(failed.context, null);
    assert.deepEqual(failed.answers, []);
    const runs = readJson(join(record, 'ranking-run.default.json'));
    assert.deepEqual(runs.cases.map((entry: Doc) => [entry.id, entry.error, entry.ranked.length > 0]), [
      ['R-1', null, true],
      ['R-2', 'invalid-scope', false],
    ]);
    assert.deepEqual(readJson(join(record, 'results.json')), output);
  });

  it('records the configured sources, their commits and whether the worktree was clean', (t) => {
    const { fixture, suite } = setup(t);
    const clean = evaluate({ suitePaths: [suite], configuredContext: () => fixture.context, recordDir: fixture.space.path('rec-clean') });
    assert.equal(clean.ok, true, JSON.stringify(clean.error));
    assert.deepEqual(clean.ranking.variants.map((variant: Doc) => variant.id), ['default']);
    assert.deepEqual(clean.ranking.comparisons, []);
    const [result] = casesOf(clean.ranking.variants[0]);
    assert.equal(result!.direct.recallAt10, 1);
    assert.deepEqual(clean.ranking.variants[0].metrics.judgments, { provisional: 0, reviewed: 1 });
    const [corpus] = clean.ranking.corpora as Doc[];
    assert.equal(corpus.kind, 'configured');
    assert.deepEqual(corpus.sources.map((source: Doc) => [source.sourceId, source.commit, source.include, source.exclude, source.worktreeClean]), [['orders', git(fixture.repo('orders'), ['rev-parse', 'HEAD']), ['**/*.md'], [], true]]);
    assert.deepEqual(readJson(fixture.space.path('rec-clean', 'review-queue.json')).cases, []);

    writeFileSync(join(fixture.repo('orders'), 'docs', 'a.md'), `${DOC}\n커밋하지 않은 변경이다.\n`);
    const dirty = evaluate({ suitePaths: [suite], configuredContext: () => fixture.context, recordDir: fixture.space.path('rec-dirty') });
    assert.equal(dirty.ranking.corpora[0].sources[0].worktreeClean, false);
    assert.equal(readJson(fixture.space.path('rec-dirty', 'manifest.json')).corpora[0].sources[0].worktreeClean, false);
  });

  it('resolves answers only within the case scope and accepts any in-scope source for a location without sourceId', (t) => {
    // 같은 경로·같은 줄 배치의 문서가 두 프로젝트에 있다
    const BILLING = '---\nkind: policy\n---\n# 청구 정책\n\n청구 본문이다.\n\n### `BR-101` 청구 기한\n\n주문 후 3일 안에 청구한다.\n';
    const fixture = knowledgeFixture(t, [
      { id: 'orders', files: { 'docs/a.md': DOC } },
      { id: 'billing', files: { 'docs/a.md': BILLING } },
    ]);
    fixture.index();
    const at = { path: 'docs/a.md', startLine: 10, endLine: 10 };
    const cases = [
      { id: 'ONE', request: { query: '배송 기한', scope: { projects: ['orders'] } }, relevant: [{ location: at }] },
      { id: 'BOTH', request: { query: '기한', scope: { projects: ['orders', 'billing'] } }, relevant: [{ location: at }] },
      { id: 'OUT', request: { query: '배송 기한', scope: { projects: ['orders'] } }, relevant: [{ id: 'orders:docs/a.md#BR-001' }, { id: 'billing:docs/a.md#BR-101' }] },
    ];
    const suite = writeYaml(fixture.space.path('real.yaml'), { schemaVersion: 2, suite: 'real-scope', profile: 'master', corpus: 'real', judgments: 'reviewed', cases });
    const output = evaluate({ suitePaths: [suite], configuredContext: () => fixture.context });
    const [variant] = output.ranking.variants as Doc[];
    const keys = (id: string): unknown[] => caseOf(variant!, id).answers.map((answer: Doc) => [answer.key, answer.unresolved]);

    // 범위 밖 원본의 같은 위치로 풀지 않는다
    const one = caseOf(variant!, 'ONE');
    assert.deepEqual(keys('ONE'), [['orders:docs/a.md#BR-001', false]]);
    assert.equal(one.direct.recallAt10, 1);
    assert.equal(JSON.stringify(one).includes('billing'), false, JSON.stringify(one));
    // 범위 안 원본이 여럿이면 어느 쪽이 나와도 정답 하나를 채우고, 한 항목 ID를 대표 키로 삼지 않는다
    assert.deepEqual(keys('BOTH'), [['*:docs/a.md:10-10', false]]);
    assert.equal(caseOf(variant!, 'BOTH').direct.recallAt10, 1);
    // 범위 밖 ID 정답은 검색이 돌려줄 수 없으므로 풀리지 않은 정답이다
    assert.deepEqual(keys('OUT'), [['orders:docs/a.md#BR-001', false], ['billing:docs/a.md#BR-101', true]]);
    assert.equal(variant!.metrics.unresolvedAnswers, 1);
  });

  it('refuses a baseline file that cannot be read or has the wrong shape', (t) => {
    const { fixture, suite } = setup(t);
    const files: [string, string | null][] = [
      ['missing.json', null],
      ['not-json.json', '{'],
      ['wrong-version.json', JSON.stringify({ ...rankingRun([]), schemaVersion: 2 })],
      ['wrong-schema.json', JSON.stringify({ ...rankingRun([]), schema: 'agent-knowledge.eval' })],
      ['bad-line.json', JSON.stringify(rankingRun([{ suite: 'real-orders', id: 'R-1', ranked: [{ path: 'docs/a.md', startLine: 0, endLine: 1 }] }]))],
    ];
    for (const [name, content] of files) {
      const path = fixture.space.path(name);
      if (content !== null) writeFileSync(path, content);
      const detail = assertEvalFailed(() => evaluate({ suitePaths: [suite], configuredContext: () => fixture.context, baselines: [path] }), 'baseline-invalid');
      assert.equal(detail.file, path, name);
    }
  });
});
