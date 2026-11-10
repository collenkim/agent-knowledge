import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it, type TestContext } from 'node:test';
import { parse, stringify } from 'yaml';
import {
  configHashOf,
  getItemV2,
  KnowledgeError,
  loadRetrievalConfig,
  QUERY_VERSION,
  RANKER_VERSIONS,
  search,
  searchV2,
  type ErrorCode,
  type Kind,
  type OutputItemV2,
  type RetrievalConfig,
  type RetrievalContext,
  type ScopeRequest,
  type SearchRequestV2,
  type SearchResponseV2,
} from '../src/index.js';
import { wordsOf } from '../src/parsing/tokenize.js';
import { QUERY_LIMIT_DEFAULTS } from '../src/profiles/config.js';
import { compareStrings } from '../src/util/compare.js';
import { commit, git, knowledgeFixture, RETRIEVAL_CONFIG_PATH, type FixtureSource, type KnowledgeFixture } from './helpers.js';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type V2Extra = Partial<Omit<SearchRequestV2, 'responseVersion'>>;

function v2(projects: string[], extra: V2Extra = {}): SearchRequestV2 {
  return { responseVersion: 2, profile: 'master', scope: { projects }, ...extra };
}

function failure(fn: () => unknown, code: ErrorCode, reason?: string): Record<string, unknown> {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code, `${error.message} ${JSON.stringify(error.detail)}`);
    const detail = (error.detail ?? {}) as Record<string, unknown>;
    if (reason !== undefined) assert.equal(detail.reason, reason, JSON.stringify(detail));
    return detail;
  }
  return assert.fail(`expected ${code}${reason === undefined ? '' : ` (${reason})`}`);
}

const ids = (response: SearchResponseV2): string[] => response.items.map((item) => item.id);
const direct = (response: SearchResponseV2): OutputItemV2[] => response.items.filter((item) => item.group === 'direct');
const limitationOf = (response: SearchResponseV2, code: string) => response.limitations.find((limitation) => limitation.code === code);

function itemOf(response: SearchResponseV2, id: string): OutputItemV2 {
  const item = response.items.find((candidate) => candidate.id === id);
  assert.ok(item, `${id} not in ${JSON.stringify(ids(response))}`);
  return item;
}

/** 순위를 비교할 때 세대 번호처럼 세대마다 달라지는 값은 뺀다. */
function rankingOf(response: SearchResponseV2): unknown[] {
  return response.items.map((item) => ({
    id: item.id,
    group: item.group,
    rank: item.selection.rank,
    directRank: item.selection.directRank,
    score: item.selection.score,
    reasons: item.selection.reasons,
    matchedTerms: item.selection.matchedTerms,
    matchedQueries: item.selection.matchedQueries,
    segment: item.segment,
    excerpt: item.excerpt,
  }));
}

/**
 * 읽기만 하는 시험끼리 색인 하나를 같이 쓴다. knowledgeFixture는 정리를 TestContext에 맡기므로 묶음이 끝날 때 대신 부른다.
 */
function sharedFixture(sources: FixtureSource[]): () => KnowledgeFixture {
  let fixture: KnowledgeFixture | undefined;
  const cleanups: (() => void)[] = [];
  before(() => {
    fixture = knowledgeFixture({ after: (fn: () => void) => void cleanups.push(fn) } as unknown as TestContext, sources);
    fixture.index();
  });
  after(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  return () => fixture!;
}

function retrievalWith(fixture: KnowledgeFixture, name: string, edit: (raw: Record<string, any>) => void): RetrievalContext {
  const raw = parse(readFileSync(RETRIEVAL_CONFIG_PATH, 'utf8')) as Record<string, any>;
  edit(raw);
  const path = fixture.space.path(`${name}.yaml`);
  writeFileSync(path, stringify(raw));
  return { ...fixture.context, retrieval: loadRetrievalConfig(path) };
}

function paragraph(lead: string): string {
  return `${lead} ${'lorem '.repeat(150)}`.slice(0, 700);
}

/**
 * 제목 줄(4행) 다음에 700자 문단 넷이 빈 줄을 사이에 두고 이어진다(6, 8, 10, 12행). 본문이 1500자를 넘으므로
 * 조각 둘로 나뉘고, 설계의 고르게 나누기 규칙으로 첫 조각은 4–8행, 둘째 조각은 10–12행이다.
 */
function longDoc(first: string, last: string): string {
  return ['---', 'kind: policy', '---', '# Long', '', paragraph(first), '', paragraph('filler'), '', paragraph('filler'), '', paragraph(last), ''].join('\n');
}

function linesOf(text: string, startLine: number, endLine: number): string {
  return text.split('\n').slice(startLine - 1, endLine).join('\n');
}

// BM25 공식 시험용 자료. 길이(토큰 수)는 제목 + 제목 경로 + 본문(제목 줄 포함)의 낱말 수다.
const CORE: Record<string, string> = {
  'docs/one.md': '# Alpha\n\nzeta zeta beta\n', // 1 + 1 + 4 = 6
  'docs/two.md': '# Gamma\n\nzeta delta delta delta delta delta\n', // 1 + 1 + 7 = 9
  'docs/three.md': '# Omega\n\nnothing here\n', // 1 + 1 + 3 = 5
  'docs/four.md': '---\nkind: policy\n---\n# Kappa\n\nzeta\n', // 1 + 1 + 2 = 4
  'docs/old.md': '---\nstatus: 폐기\n---\n# Old\n\nzeta beta\n', // 1 + 1 + 3 = 5
};
const ONE = 'core:docs/one.md#alpha';
const TWO = 'core:docs/two.md#gamma';
const FOUR = 'core:docs/four.md#kappa';
const OLD = 'core:docs/old.md#old';

interface UnitFacts {
  tf: Record<string, number>;
  length: number;
}

/** 범위 안 단위 수, 평균 길이, 문서 빈도. 폐기 항목도 범위 안이므로 통계에 들어간다. */
const CORE_STATS = { units: 5, averageLength: (6 + 9 + 5 + 4 + 5) / 5, df: { zeta: 4, beta: 2 } as Record<string, number> };
const CORE_UNITS: Record<string, UnitFacts & { kind: Kind; status: 'unverified' | 'deprecated' }> = {
  [ONE]: { tf: { zeta: 2, beta: 1 }, length: 6, kind: 'reference', status: 'unverified' },
  [TWO]: { tf: { zeta: 1 }, length: 9, kind: 'reference', status: 'unverified' },
  [FOUR]: { tf: { zeta: 1 }, length: 4, kind: 'policy', status: 'unverified' },
  [OLD]: { tf: { zeta: 1, beta: 1 }, length: 5, kind: 'reference', status: 'deprecated' },
};

/** 설계의 식을 그대로 옮긴다. textScore = Σ idf·tf·(k1+1)/(tf + k1·norm) / Σ idf·(k1+1). 검색어가 본문에만 있으므로 tf는 본문 가중치 배다. */
function bm25Expected(unit: UnitFacts, terms: string[], stats: typeof CORE_STATS, params: { k1: number; b: number; body: number } = { k1: 1.2, b: 0.75, body: 1 }): number {
  const norm = 1 - params.b + (params.b * unit.length) / stats.averageLength;
  let sum = 0;
  let ceiling = 0;
  for (const term of terms) {
    const df = stats.df[term]!;
    const idf = Math.log(1 + (stats.units - df + 0.5) / (df + 0.5));
    ceiling += idf * (params.k1 + 1);
    const tf = params.body * (unit.tf[term] ?? 0);
    if (tf > 0) sum += (idf * tf * (params.k1 + 1)) / (tf + params.k1 * norm);
  }
  return sum / ceiling;
}

function weightOf(retrieval: RetrievalConfig, kind: Kind, status: 'unverified' | 'deprecated'): number {
  return retrieval.profiles.master.kindWeights[kind] * retrieval.ranking.statusWeights[status];
}

function assertScore(item: OutputItemV2, expected: number): void {
  assert.ok(Math.abs(item.selection.score - expected) <= 1e-6, `${item.id}: ${item.selection.score} != ${expected}`);
}

function noiseDocs(prefix: string, count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`docs/${prefix}${index}.md`, `# Noise ${prefix} ${index}\n\nzeta beta zeta beta beta\n`]));
}

const NOISE_SEED = { 'docs/seed.md': '# Seed\n\nunrelated words only\n' };

describe('ranker selection', () => {
  const fixture = sharedFixture([{ id: 'core', files: CORE }]);

  it('defaults to the legacy ranker and reports the query version', () => {
    const response = searchV2(fixture().context, v2(['core'], { query: 'zeta beta' }));
    assert.deepEqual(response.retrieval.ranker, { name: 'legacy', version: 'keyword-legacy-1' });
    assert.equal(response.retrieval.queryVersion, 'query-2');
    assert.equal(response.request.ranker, 'legacy');
    assert.deepEqual(RANKER_VERSIONS, { legacy: 'keyword-legacy-1', bm25: 'keyword-bm25-2' });
    assert.equal(QUERY_VERSION, 'query-2');
  });

  it('selects bm25 on request', () => {
    const response = searchV2(fixture().context, v2(['core'], { query: 'zeta beta', ranker: 'bm25' }));
    assert.deepEqual(response.retrieval.ranker, { name: 'bm25', version: 'keyword-bm25-2' });
    assert.equal(response.retrieval.queryVersion, 'query-2');
    assert.equal(response.request.ranker, 'bm25');
  });

  it('adds the title and key boosts only to the legacy ranker', () => {
    const base = fixture();
    // alpha는 ONE의 제목에만 있다. 제목 가산점을 크게 바꿔도 BM25 점수는 그대로이고 기존 순위의 점수만 바뀐다
    const boosted = retrievalWith(base, 'title-boost', (raw) => {
      raw.ranking.fieldBoosts.title = 5;
      raw.ranking.fieldBoosts.keyOrAlias = 5;
    });
    const scoreIn = (context: RetrievalContext, ranker: 'legacy' | 'bm25'): number => itemOf(searchV2(context, v2(['core'], { query: 'alpha zeta', ranker })), ONE).selection.score;
    assert.equal(scoreIn(boosted, 'bm25'), scoreIn(base.context, 'bm25'));
    assert.ok(scoreIn(boosted, 'legacy') > scoreIn(base.context, 'legacy') + 1);
    assert.ok(itemOf(searchV2(base.context, v2(['core'], { query: 'alpha zeta', ranker: 'legacy' })), ONE).selection.reasons.includes('keyword-match'));
  });

  it('rejects an unknown ranker and a ranker in a version 1 request', () => {
    const { context } = fixture();
    failure(() => searchV2(context, { ...v2(['core'], { query: 'zeta' }), ranker: 'vector' } as unknown as SearchRequestV2), 'invalid-request');
    const detail = failure(() => search(context, { profile: 'master', query: 'zeta', scope: { projects: ['core'] }, ranker: 'bm25' } as never), 'invalid-request', 'response-version-2-required');
    assert.deepEqual(detail.fields, ['ranker']);
  });

  it('keeps the legacy formula and the v1 order for a single query', () => {
    const { context } = fixture();
    const v1 = search(context, { profile: 'master', query: 'zeta beta', scope: { projects: ['core'] } });
    const response = searchV2(context, v2(['core'], { query: 'zeta beta' }));
    assert.deepEqual(
      response.items.map((item) => [item.id, item.selection.rank, item.selection.score, item.selection.reasons]),
      v1.items.map((item) => [item.id, item.selection.rank, item.selection.score, item.selection.reasons]),
    );
    // 일치 비율 0.6 + 순번 0.4. ONE만 두 검색어를 모두 담는다
    const weight = weightOf(context.retrieval, 'reference', 'unverified');
    assertScore(itemOf(response, ONE), 1 * weight);
  });

  it('scores bm25 with the documented formula over in-scope units only', (t) => {
    const local = knowledgeFixture(t, [
      { id: 'core', files: CORE },
      { id: 'noise', files: noiseDocs('n', 15) },
    ]);
    local.index();
    const { retrieval } = local.context;
    const terms = ['zeta', 'beta'];
    for (const statuses of [undefined, ['unverified', 'deprecated'] as const]) {
      const response = searchV2(local.context, v2(['core'], { query: 'zeta beta', ranker: 'bm25', ...(statuses ? { filters: { statuses: [...statuses] } } : {}) }));
      const expected = Object.entries(CORE_UNITS)
        .filter(([, unit]) => statuses !== undefined || unit.status !== 'deprecated')
        .map(([id, unit]) => ({ id, score: bm25Expected(unit, terms, CORE_STATS) * weightOf(retrieval, unit.kind, unit.status) }))
        .sort((a, b) => b.score - a.score || compareStrings(a.id, b.id));
      assert.deepEqual(ids(response), expected.map((entry) => entry.id));
      for (const { id, score } of expected) assertScore(itemOf(response, id), score);
      for (const item of response.items) {
        assert.ok(item.selection.score < weightOf(retrieval, item.kind, item.knowledge.status as 'unverified' | 'deprecated'), 'textScore must stay below 1');
        assert.deepEqual(item.selection.reasons, ['keyword-match']);
      }
    }
  });

  it('applies bm25 parameters from the retrieval config', () => {
    const base = fixture();
    const context = retrievalWith(base, 'bm25-params', (raw) => {
      raw.ranking.bm25 = { k1: 2, b: 0.5, fieldWeights: { key_aliases: 4, title: 3, headings: 2, body: 3 } };
    });
    const response = searchV2(context, v2(['core'], { query: 'zeta beta', ranker: 'bm25' }));
    const params = { k1: 2, b: 0.5, body: 3 };
    for (const id of [ONE, TWO, FOUR]) {
      const unit = CORE_UNITS[id]!;
      assertScore(itemOf(response, id), bm25Expected(unit, ['zeta', 'beta'], CORE_STATS, params) * weightOf(context.retrieval, unit.kind, unit.status));
    }
    assert.notEqual(response.retrieval.configHash, searchV2(base.context, v2(['core'], { query: 'zeta beta', ranker: 'bm25' })).retrieval.configHash);
  });

  it('cuts candidates at candidateLimit in the order of the chosen ranker', () => {
    const context = retrievalWith(fixture(), 'candidate-limit', (raw) => {
      raw.ranking.candidateLimit = 1;
    });
    // 기존 순위는 일치 비율·가중 일치가 같으면 ID순(FOUR)이고, BM25는 zeta가 두 번 나오는 ONE을 앞에 둔다
    const legacy = searchV2(context, v2(['core'], { query: 'zeta' }));
    const bm25 = searchV2(context, v2(['core'], { query: 'zeta', ranker: 'bm25' }));
    assert.deepEqual(ids(legacy), [FOUR]);
    assert.deepEqual(ids(bm25), [ONE]);
    for (const response of [legacy, bm25]) assert.deepEqual(limitationOf(response, 'candidates-truncated')?.detail, { total: 3, limit: 1 });
    const multi = searchV2(context, v2(['core'], { queries: ['zeta', 'beta'], ranker: 'bm25' }));
    assert.deepEqual(limitationOf(multi, 'candidates-truncated')?.detail, { total: 3, limit: 1, queries: ['q1'] });
  });

  it('takes the best score over queries and unions matched queries and terms', () => {
    const { context } = fixture();
    const response = searchV2(context, v2(['core'], { queries: ['zeta', 'beta'], ranker: 'bm25' }));
    const one = itemOf(response, ONE);
    const unit = CORE_UNITS[ONE]!;
    const best = Math.max(bm25Expected(unit, ['zeta'], CORE_STATS), bm25Expected(unit, ['beta'], CORE_STATS));
    assertScore(one, best * weightOf(context.retrieval, 'reference', 'unverified'));
    assert.deepEqual(one.selection.matchedQueries, ['q1', 'q2']);
    assert.deepEqual(one.selection.matchedTerms, ['zeta', 'beta']);
    const two = itemOf(response, TWO);
    assert.deepEqual(two.selection.matchedQueries, ['q1']);
    assertScore(two, bm25Expected(CORE_UNITS[TWO]!, ['zeta'], CORE_STATS) * weightOf(context.retrieval, 'reference', 'unverified'));
  });
});

describe('bm25 statistics stay inside the effective scope', () => {
  const REQUESTS: { label: string; request: SearchRequestV2 }[] = [];
  for (const ranker of ['legacy', 'bm25'] as const) {
    for (const segments of [false, true]) {
      for (const projects of [['core'], ['core', 'longp']]) {
        REQUESTS.push({ label: `${ranker} segments=${segments} ${projects.join('+')}`, request: v2(projects, { query: 'zeta beta', queries: ['wombat'], ranker, segments }) });
      }
    }
  }
  const SOURCES = (): FixtureSource[] => [
    { id: 'core', files: CORE },
    { id: 'longp', files: { 'docs/long.md': longDoc('zeta', 'beta wombat') } },
    { id: 'noise', files: NOISE_SEED },
  ];

  function snapshot(context: RetrievalContext, version?: { generation: number }): { ranking: unknown[]; fingerprint: string; generation: number }[] {
    return REQUESTS.map(({ request }) => {
      const response = searchV2(context, version ? { ...request, version } : request);
      return { ranking: rankingOf(response), fingerprint: response.index.scopeFingerprint, generation: response.index.generation };
    });
  }

  function assertSame(actual: ReturnType<typeof snapshot>, expected: ReturnType<typeof snapshot>, generation: number): void {
    REQUESTS.forEach(({ label }, index) => {
      assert.equal(actual[index]!.generation, generation, label);
      assert.deepEqual(actual[index]!.ranking, expected[index]!.ranking, label);
      assert.equal(actual[index]!.fingerprint, expected[index]!.fingerprint, label);
    });
  }

  it('does not move when only an unrelated project changes, and pinning old or new gives the same result', (t) => {
    const fixture = knowledgeFixture(t, SOURCES());
    assert.equal(fixture.index().generation, 1);
    const first = snapshot(fixture.context);
    assert.ok(first.every((entry) => entry.ranking.length > 0));
    const control = v2(['core', 'noise'], { query: 'zeta beta', ranker: 'bm25' });
    const controlBefore = searchV2(fixture.context, control);

    commit(fixture.repo('noise'), noiseDocs('a', 25));
    assert.equal(fixture.index().generation, 2);

    assertSame(snapshot(fixture.context), first, 2);
    assertSame(snapshot(fixture.context, { generation: 1 }), first, 1);
    assertSame(snapshot(fixture.context, { generation: 2 }), first, 2);

    // 대조군: 바뀐 프로젝트를 범위에 넣으면 같은 핵심 항목의 점수가 달라져야 시험이 헛돌지 않는다
    const controlAfter = searchV2(fixture.context, control);
    const coreScores = (response: SearchResponseV2) => response.items.filter((item) => item.projectId === 'core').map((item) => [item.id, item.selection.score]);
    assert.notDeepEqual(coreScores(controlAfter), coreScores(controlBefore));
    assert.notEqual(controlAfter.index.scopeFingerprint, controlBefore.index.scopeFingerprint);
  });

  it('does not move when GC trims old generations', (t) => {
    const fixture = knowledgeFixture(t, SOURCES(), 1);
    fixture.index();
    const first = snapshot(fixture.context);

    commit(fixture.repo('noise'), noiseDocs('a', 25));
    assert.equal(fixture.index().generation, 2);
    failure(() => searchV2(fixture.context, { ...REQUESTS[0]!.request, version: { generation: 1 } }), 'index-missing', 'generation-not-found');
    assertSame(snapshot(fixture.context), first, 2);

    const removed = Object.fromEntries(Object.keys(noiseDocs('a', 25)).map((path) => [path, null]));
    commit(fixture.repo('noise'), { ...removed, ...noiseDocs('b', 40) });
    assert.equal(fixture.index().generation, 3);
    failure(() => searchV2(fixture.context, { ...REQUESTS[0]!.request, version: { generation: 2 } }), 'index-missing', 'generation-not-found');
    assertSame(snapshot(fixture.context), first, 3);
  });

  it('counts allowed-link items only when the link restriction admits them', (t) => {
    const fixture = knowledgeFixture(t, [
      { id: 'core', files: CORE },
      { id: 'noise', files: noiseDocs('n', 15) },
    ]);
    fixture.index();
    const scoresOf = (scope: SearchRequestV2['scope']) => {
      const response = searchV2(fixture.context, { ...v2(['core'], { query: 'zeta beta', ranker: 'bm25' }), scope });
      return response.items.filter((item) => item.projectId === 'core').map((item) => [item.id, item.selection.score]);
    };
    const alone = scoresOf({ projects: ['core'] });
    // 소음 프로젝트에는 reference만 있으므로 기본 연결 종류(contract·dependency·api-catalog)나 contract만 허용하면 범위가 같다
    assert.deepEqual(scoresOf({ projects: ['core'], allowedLinks: [{ project: 'noise' }] }), alone);
    assert.deepEqual(scoresOf({ projects: ['core'], allowedLinks: [{ project: 'noise', kinds: ['contract'] }] }), alone);
    assert.notDeepEqual(scoresOf({ projects: ['core'], allowedLinks: [{ project: 'noise', kinds: ['reference'] }] }), alone);

    // itemIds로 하나만 허용하면 그 단위 하나만 통계에 더해진다. 제목·경로 'Noise n 0' 3 + 3, 본문 8 = 14
    const linked = searchV2(fixture.context, { ...v2(['core'], { query: 'zeta beta', ranker: 'bm25' }), scope: { projects: ['core'], allowedLinks: [{ project: 'noise', kinds: ['reference'], itemIds: ['noise:docs/n0.md#noise-n-0'] }] } });
    const stats = { units: CORE_STATS.units + 1, averageLength: (CORE_STATS.averageLength * CORE_STATS.units + 14) / (CORE_STATS.units + 1), df: { zeta: 5, beta: 3 } };
    const unit = CORE_UNITS[ONE]!;
    assertScore(itemOf(linked, ONE), bm25Expected(unit, ['zeta', 'beta'], stats) * weightOf(fixture.context.retrieval, unit.kind, unit.status));
    assert.deepEqual(linked.items.filter((item) => item.projectId === 'noise').map((item) => item.id), ['noise:docs/n0.md#noise-n-0']);
  });

  it('keeps the score scale when kind, status, document filters or task paths narrow the candidates', (t) => {
    const fixture = knowledgeFixture(t, [{ id: 'core', files: CORE }]);
    fixture.index();
    const scoreOf = (extra: V2Extra) => itemOf(searchV2(fixture.context, v2(['core'], { query: 'zeta beta', ranker: 'bm25', ...extra })), ONE).selection.score;
    const unfiltered = scoreOf({});
    assert.equal(scoreOf({ filters: { kinds: ['reference'] } }), unfiltered);
    assert.equal(scoreOf({ filters: { statuses: ['unverified'] } }), unfiltered);
    assert.equal(scoreOf({ filters: { documents: ['docs/one.md'] } }), unfiltered);
    assert.equal(scoreOf({ task: { paths: ['src/unrelated.ts'] } }), unfiltered);
    const narrowed = searchV2(fixture.context, v2(['core'], { query: 'zeta beta', ranker: 'bm25', filters: { documents: ['docs/one.md'] } }));
    assert.deepEqual(ids(narrowed), [ONE]);
  });
});

const PLAN = {
  'docs/cache.md': '# Cache policy\n\ncache eviction uses lru.\n',
  'docs/evict.md': '# Eviction\n\neviction runs nightly.\n',
  'docs/warm.md': '# Warmup\n\nwarmup follows the cache fill.\n',
  'docs/key.md': '### `BR-100` 키 규칙\n\nkey rule body.\n',
};
const CACHE = 'plan:docs/cache.md#cache-policy';
const EVICT = 'plan:docs/evict.md#eviction';
const WARM = 'plan:docs/warm.md#warmup';
const KEYED = 'plan:docs/key.md#BR-100';

const words = (prefix: string, count: number): string => Array.from({ length: count }, (_, index) => `${prefix}x${index}`).join(' ');

describe('query planning', () => {
  const fixture = sharedFixture([{ id: 'plan', files: PLAN }]);
  const plan = (extra: V2Extra) => searchV2(fixture().context, v2(['plan'], extra));

  it('merges several queries and records which query matched each item', () => {
    const response = plan({ queries: ['cache', 'eviction'] });
    assert.deepEqual(new Set(ids(response)), new Set([CACHE, EVICT, WARM]));
    assert.deepEqual(itemOf(response, CACHE).selection.matchedQueries, ['q1', 'q2']);
    assert.deepEqual(itemOf(response, EVICT).selection.matchedQueries, ['q2']);
    assert.deepEqual(itemOf(response, WARM).selection.matchedQueries, ['q1']);
    assert.equal(response.request.query, null);
    assert.deepEqual(response.request.queries, [
      { key: 'q1', chars: 5, sha256: sha256('cache'), duplicateOf: null },
      { key: 'q2', chars: 8, sha256: sha256('eviction'), duplicateOf: null },
    ]);
  });

  it('keys `query` first and string entries by their position in queries', () => {
    const response = plan({ query: 'cache', queries: ['eviction', { key: 'ev.2:x-y_Z', text: 'warmup' }, { text: 'lru' }, 'nightly'] });
    assert.deepEqual(response.request.queries.map((entry) => entry.key), ['query', 'q1', 'ev.2:x-y_Z', 'q3', 'q4']);
    assert.deepEqual(itemOf(response, WARM).selection.matchedQueries, ['query', 'ev.2:x-y_Z']);
    assert.deepEqual(itemOf(response, CACHE).selection.matchedQueries, ['query', 'q1', 'q3']);
    assert.deepEqual(itemOf(response, EVICT).selection.matchedQueries, ['q1', 'q4']);
  });

  it('attributes an explicit key hit to the query that named it', () => {
    const response = plan({ queries: ['warmup', 'BR-100을'] });
    const keyed = itemOf(response, KEYED);
    assert.ok(keyed.selection.reasons.includes('explicit-key'));
    assert.deepEqual(keyed.selection.matchedQueries, ['q2']);
  });

  it('rejects malformed query keys and entries', () => {
    for (const key of ['bad key', '', 'k'.repeat(65), 'ключ', 'a/b', 'a#b']) {
      failure(() => plan({ queries: [{ key, text: 'cache' }] }), 'invalid-request');
    }
    plan({ queries: [{ key: 'k'.repeat(64), text: 'cache' }] });
    failure(() => plan({ queries: [] }), 'invalid-request');
    failure(() => plan({ queries: [''] }), 'invalid-request');
    failure(() => plan({ queries: [{ key: 'x', text: '' }] }), 'invalid-request');
    failure(() => plan({ queries: [{ key: 'x', text: 'cache', extra: 1 } as never] }), 'invalid-request');
    failure(() => plan({ queries: ['cache'], overflow: 'drop' as never }), 'invalid-request');
  });

  it('rejects duplicate keys, including a collision with a positional key or `query`', () => {
    assert.equal(failure(() => plan({ queries: [{ key: 'q2', text: 'cache' }, 'eviction'] }), 'invalid-request', 'duplicate-query-key').key, 'q2');
    assert.equal(failure(() => plan({ query: 'cache', queries: [{ key: 'query', text: 'eviction' }] }), 'invalid-request', 'duplicate-query-key').key, 'query');
    assert.equal(failure(() => plan({ queries: [{ key: 'a', text: 'cache' }, { key: 'a', text: 'cache' }] }), 'invalid-request', 'duplicate-query-key').key, 'a');
  });

  it('dedupes queries that are equal after normalisation and echoes only key, length and digest', () => {
    const texts = ['Cache  Eviction', 'cache eviction', ' CACHE\tEVICTION ', 'cafe\u0301 lru', 'caf\u00e9 LRU'];
    const response = plan({ queries: texts });
    assert.deepEqual(limitationOf(response, 'queries-deduplicated')?.detail, { duplicates: { q1: ['q2', 'q3'], q4: ['q5'] } });
    assert.deepEqual(
      response.request.queries,
      texts.map((text, index) => ({ key: `q${index + 1}`, chars: text.length, sha256: sha256(text), duplicateOf: index === 1 || index === 2 ? 'q1' : index === 4 ? 'q4' : null })),
    );
    for (const entry of response.request.queries) assert.deepEqual(Object.keys(entry).sort(compareStrings), ['chars', 'duplicateOf', 'key', 'sha256']);
    const echo = JSON.stringify(response.request);
    for (const raw of ['Cache', 'cache', 'EVICTION', 'eviction', 'lru', 'LRU']) assert.equal(echo.includes(raw), false, raw);
    assert.deepEqual(itemOf(response, CACHE).selection.matchedQueries, ['q1', 'q2', 'q3', 'q4', 'q5']);
    assert.deepEqual(itemOf(response, EVICT).selection.matchedQueries, ['q1', 'q2', 'q3']);
  });

  it('dedupes a queries entry against `query`', () => {
    const response = plan({ query: 'cache eviction', queries: ['Cache Eviction'] });
    assert.deepEqual(response.request.queries.map((entry) => entry.duplicateOf), [null, 'query']);
    assert.deepEqual(limitationOf(response, 'queries-deduplicated')?.detail, { duplicates: { query: ['q1'] } });
  });

  it('rejects or truncates too many queries', () => {
    const max = QUERY_LIMIT_DEFAULTS.maxQueries;
    assert.equal(max, 32);
    const many = Array.from({ length: max + 1 }, (_, index) => `w${index}`);
    assert.deepEqual(failure(() => plan({ queries: many }), 'invalid-request', 'too-many-queries'), { reason: 'too-many-queries', count: max + 1, max });
    assert.deepEqual(failure(() => plan({ query: 'cache', queries: many.slice(0, max) }), 'invalid-request', 'too-many-queries'), { reason: 'too-many-queries', count: max + 1, max });
    plan({ queries: many.slice(0, max) });

    const truncated = plan({ query: 'cache', queries: many.slice(0, max), overflow: 'truncate' });
    assert.deepEqual(limitationOf(truncated, 'queries-truncated')?.detail, { droppedKeys: [`q${max}`], max });
    assert.equal(truncated.request.queries.length, max);
    assert.equal(truncated.request.queries.at(-1)!.key, `q${max - 1}`);
    assert.ok(ids(truncated).includes(CACHE));
  });

  it('rejects or truncates a query longer than maxQueryChars, `query` included', () => {
    const max = QUERY_LIMIT_DEFAULTS.maxQueryChars;
    const long = `cache ${'x'.repeat(max - 5)}`;
    assert.equal(long.length, max + 1);
    assert.deepEqual(failure(() => plan({ queries: ['eviction', long] }), 'invalid-request', 'query-too-long'), { reason: 'query-too-long', key: 'q2', chars: max + 1, max });
    assert.equal(failure(() => plan({ query: long }), 'invalid-request', 'query-too-long').key, 'query');
    plan({ queries: [long.slice(0, max)] });

    const truncated = plan({ queries: [long], overflow: 'truncate' });
    assert.deepEqual(limitationOf(truncated, 'query-text-truncated')?.detail, { chars: { q1: max + 1 }, max });
    // 앞부분을 남기므로 첫 검색어로는 여전히 찾는다
    assert.ok(ids(truncated).includes(CACHE));
  });

  it('drops terms beyond maxTermsPerQuery in order without failing', () => {
    const max = QUERY_LIMIT_DEFAULTS.maxTermsPerQuery;
    const kept = plan({ queries: [`cache ${words('t', max + 1)}`] });
    assert.deepEqual(limitationOf(kept, 'query-terms-truncated')?.detail, { terms: { q1: max + 2 }, max });
    assert.ok(ids(kept).includes(CACHE));

    const dropped = plan({ queries: [`${words('t', max)} cache eviction`] });
    assert.deepEqual(limitationOf(dropped, 'query-terms-truncated')?.detail, { terms: { q1: max + 2 }, max });
    assert.equal(dropped.status, 'no-results');
    assert.deepEqual(ids(dropped), []);
  });

  it('caps the total number of terms across queries', () => {
    const perQuery = QUERY_LIMIT_DEFAULTS.maxTermsPerQuery;
    const total = QUERY_LIMIT_DEFAULTS.maxTotalTerms;
    const full = Math.floor(total / perQuery);
    const queries = Array.from({ length: full }, (_, index) => words(`f${index}`, perQuery));
    queries.push(`cache ${words('tail', perQuery - 1)}`, 'eviction');
    const response = plan({ queries });
    const keys = [`q${full + 1}`, `q${full + 2}`];
    assert.deepEqual(limitationOf(response, 'query-work-truncated')?.detail, { keys, max: total });
    // 남은 자리만큼 앞쪽 검색어는 쓰고, 자리가 없는 질의는 아무것도 찾지 않는다
    assert.ok(ids(response).includes(CACHE));
    assert.equal(ids(response).includes(EVICT), false);
    assert.equal(response.request.queries.length, full + 2);
    assert.deepEqual(itemOf(response, CACHE).selection.matchedQueries, [keys[0]]);
  });

  it('reads the limits from the retrieval config', () => {
    const context = retrievalWith(fixture(), 'limits', (raw) => {
      raw.limits = { maxQueries: 2, maxTermsPerQuery: 2 };
    });
    assert.deepEqual(failure(() => searchV2(context, v2(['plan'], { queries: ['a', 'b', 'c'] })), 'invalid-request', 'too-many-queries'), { reason: 'too-many-queries', count: 3, max: 2 });
    const response = searchV2(context, v2(['plan'], { query: 'warmup nightly cache' }));
    assert.deepEqual(limitationOf(response, 'query-terms-truncated')?.detail, { terms: { query: 3 }, max: 2 });
    assert.equal(ids(response).includes(CACHE), false);
    assert.notEqual(response.retrieval.configHash, plan({ query: 'warmup nightly cache' }).retrieval.configHash);
  });

  it('does not apply v2 limits to v1 requests and refuses v2 query fields there', () => {
    const { context } = fixture();
    const response = search(context, { profile: 'master', query: `cache ${'x'.repeat(QUERY_LIMIT_DEFAULTS.maxQueryChars + 10)}`, scope: { projects: ['plan'] } });
    assert.ok(response.items.some((item) => item.id === CACHE));
    for (const field of ['queries', 'overflow'] as const) {
      const detail = failure(() => search(context, { profile: 'master', query: 'cache', scope: { projects: ['plan'] }, [field]: field === 'queries' ? ['x'] : 'truncate' } as never), 'invalid-request', 'response-version-2-required');
      assert.deepEqual(detail.fields, [field]);
    }
  });
});

function policyDoc(title: string): string {
  return `---\nkind: policy\n---\n# ${title}\n\nledger body text.\n`;
}

const NORTH = {
  'docs/p1.md': policyDoc('ledger rule one'),
  'docs/p2.md': policyDoc('ledger rule two'),
  'docs/p3.md': policyDoc('ledger rule three'),
  'docs/p4.md': policyDoc('ledger rule four'),
  'docs/p5.md': policyDoc('ledger rule five'),
  'docs/misc.md': '# misc notes\n\nledger mention.\n',
  'docs/unrelated.md': '# unrelated\n\nnothing to see.\n',
};
const SOUTH = {
  'docs/s1.md': '# south one\n\nledger appears here.\n',
  'docs/s2.md': '# south two\n\nledger appears too.\n',
};
const MISC = 'north:docs/misc.md#misc-notes';
const UNRELATED = 'north:docs/unrelated.md#unrelated';

describe('quota and composition', () => {
  const fixture = sharedFixture([
    { id: 'north', files: NORTH },
    { id: 'south', files: SOUTH },
  ]);
  const run = (projects: string[], extra: V2Extra) => searchV2(fixture().context, v2(projects, { query: 'ledger', ...extra }));

  function assertMatchedOnly(response: SearchResponseV2): void {
    for (const item of direct(response)) {
      assert.ok(item.selection.reasons.includes('keyword-match'), item.id);
      assert.notEqual(item.id, UNRELATED);
    }
    assert.deepEqual(direct(response).map((item) => item.selection.directRank), direct(response).map((_, index) => index + 1));
    const scores = direct(response).map((item) => item.selection.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  }

  function perProject(response: SearchResponseV2): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of direct(response)) counts[item.projectId] = (counts[item.projectId] ?? 0) + 1;
    return counts;
  }

  it('lets the strongest project fill the limit without a quota and reports the skew', () => {
    for (const ranker of ['legacy', 'bm25'] as const) {
      const response = run(['north', 'south'], { limit: 4, ranker });
      assert.deepEqual(response.retrieval.composition.direct, { byProject: { north: 4 }, byKind: { policy: 4 } }, ranker);
      assert.equal(response.retrieval.counts.directMatched, 8);
      assert.equal(response.retrieval.counts.direct, 4);
      assert.equal(limitationOf(response, 'quota-unmet'), undefined);
    }
  });

  it('caps direct items per project', () => {
    for (const ranker of ['legacy', 'bm25'] as const) {
      const response = run(['north', 'south'], { limit: 4, ranker, quota: { maxPerProject: 2 } });
      assert.deepEqual(perProject(response), { north: 2, south: 2 }, ranker);
      assert.deepEqual(response.retrieval.composition.direct, { byProject: { north: 2, south: 2 }, byKind: { policy: 2, reference: 2 } }, ranker);
      assertMatchedOnly(response);
      assert.deepEqual(response.request.quota, { maxPerProject: 2 });
    }
  });

  it('leaves slots empty rather than exceeding maxPerProject', () => {
    const response = run(['north', 'south'], { limit: 10, quota: { maxPerProject: 1 } });
    assert.deepEqual(perProject(response), { north: 1, south: 1 });
    assert.equal(direct(response).length, 2);
    assert.equal(response.retrieval.counts.directMatched, 8);
    assertMatchedOnly(response);
  });

  it('reserves minPerKind from matching candidates and reports quota-unmet instead of force-filling', () => {
    for (const ranker of ['legacy', 'bm25'] as const) {
      const response = run(['north'], { limit: 3, ranker, quota: { minPerKind: { reference: 3 } } });
      assert.deepEqual(limitationOf(response, 'quota-unmet')?.detail, { kinds: { reference: { required: 3, selected: 1 } } }, ranker);
      assert.equal(ids(response).includes(UNRELATED), false);
      assert.ok(ids(response).includes(MISC));
      assert.deepEqual(response.retrieval.composition.direct.byKind, { policy: 2, reference: 1 });
      assertMatchedOnly(response);
      // 최소 수로 넣은 항목도 최종 순서는 점수순이다
      assert.equal(direct(response).at(-1)!.id, MISC);
    }
  });

  it('reports a kind with no matches as unmet with zero selected', () => {
    const response = run(['north', 'south'], { limit: 3, quota: { minPerKind: { contract: 2, reference: 1 } } });
    assert.deepEqual(limitationOf(response, 'quota-unmet')?.detail, { kinds: { contract: { required: 2, selected: 0 } } });
    assert.equal(direct(response).length, 3);
    assert.equal(direct(response).some((item) => item.kind === 'contract'), false);
    assert.equal(response.retrieval.composition.direct.byKind.reference, 1);
    assertMatchedOnly(response);
  });

  it('meets minPerKind when enough matches exist', () => {
    const response = run(['north', 'south'], { limit: 3, quota: { minPerKind: { reference: 2 } } });
    assert.equal(limitationOf(response, 'quota-unmet'), undefined);
    assert.deepEqual(response.retrieval.composition.direct.byKind, { policy: 1, reference: 2 });
    assertMatchedOnly(response);
  });

  it('honours maxPerProject while reserving minPerKind', () => {
    const response = run(['north', 'south'], { limit: 3, quota: { minPerKind: { reference: 1 }, maxPerProject: 1 } });
    const counts = perProject(response);
    assert.ok(Object.values(counts).every((count) => count <= 1), JSON.stringify(counts));
    assert.ok(direct(response).some((item) => item.kind === 'reference'));
    assertMatchedOnly(response);
  });

  it('reports a minPerKind that cannot fit under the limit', () => {
    const response = run(['north', 'south'], { limit: 2, quota: { minPerKind: { policy: 3, reference: 3 } } });
    assert.deepEqual(limitationOf(response, 'quota-unmet')?.detail, { kinds: { policy: { required: 3, selected: 2 }, reference: { required: 3, selected: 0 } } });
    assert.equal(direct(response).length, 2);
  });

  it('rejects malformed quotas and quotas in v1 requests', () => {
    failure(() => run(['north'], { quota: { maxPerProject: 0 } }), 'invalid-request');
    failure(() => run(['north'], { quota: { maxPerProject: 1.5 } }), 'invalid-request');
    failure(() => run(['north'], { quota: { minPerKind: { bogus: 1 } } as never }), 'invalid-request');
    failure(() => run(['north'], { quota: { minPerKind: { policy: 0 } } }), 'invalid-request');
    failure(() => run(['north'], { quota: { minPerKind: { policy: 51 } } }), 'invalid-request');
    failure(() => run(['north'], { quota: { other: 1 } as never }), 'invalid-request');
    const detail = failure(() => search(fixture().context, { profile: 'master', query: 'ledger', scope: { projects: ['north'] }, quota: { maxPerProject: 1 } } as never), 'invalid-request', 'response-version-2-required');
    assert.deepEqual(detail.fields, ['quota']);
  });

  it('counts composition over the direct items that survive the budget', () => {
    const response = run(['north', 'south'], { limit: 4, quota: { maxPerProject: 2 }, budget: { maxItems: 3 } });
    assert.equal(response.retrieval.counts.direct, 4);
    assert.equal(response.retrieval.counts.kept.direct, 3);
    const byProject = response.retrieval.composition.direct.byProject;
    assert.equal(Object.values(byProject).reduce((sum, count) => sum + count, 0), 3);
    assert.deepEqual(byProject, perProject(response));
  });
});

const LIB = {
  'docs/a.md': '# ledger a\n\nledger alpha.\n',
  'docs/sub/b.md': '# ledger b\n\nledger beta.\n',
  'guides/c.md': '# ledger c\n\nledger gamma.\n',
  'guides-extra/d.md': '# ledger d\n\nledger delta.\n',
};
const AUX = {
  'docs/a.md': '# ledger aux\n\nledger aux.\n',
  'guides/c.md': '# ledger auxc\n\nledger.\n',
};
const LIB_A = 'lib:docs/a.md#ledger-a';
const LIB_B = 'lib:docs/sub/b.md#ledger-b';
const LIB_C = 'lib:guides/c.md#ledger-c';
const LIB_D = 'lib:guides-extra/d.md#ledger-d';
const AUX_A = 'auxzz:docs/a.md#ledger-aux';
const AUX_C = 'auxzz:guides/c.md#ledger-auxc';

describe('document filters', () => {
  const fixture = sharedFixture([
    { id: 'lib', files: LIB },
    { id: 'auxzz', files: AUX },
  ]);
  const run = (projects: string[], documents: string[], extra: V2Extra = {}) => searchV2(fixture().context, v2(projects, { query: 'ledger', filters: { documents }, ...extra }));
  const sortedIds = (response: SearchResponseV2): string[] => ids(response).sort(compareStrings);

  it('filters by exact path in a single-project scope', () => {
    const response = run(['lib'], ['docs/a.md']);
    assert.deepEqual(ids(response), [LIB_A]);
    assert.deepEqual(response.appliedScope.documents, [{ project: 'lib', path: 'docs/a.md' }]);
    assert.deepEqual(response.request.documents, ['docs/a.md']);
  });

  it('filters by directory prefix only when the entry ends with a slash', () => {
    assert.deepEqual(sortedIds(run(['lib'], ['docs/'])), [LIB_A, LIB_B]);
    assert.deepEqual(sortedIds(run(['lib'], ['guides/'])), [LIB_C]);
    const exact = run(['lib'], ['guides']);
    assert.deepEqual(ids(exact), []);
    assert.equal(exact.status, 'no-results');
    assert.deepEqual(sortedIds(run(['lib'], ['docs/a.md', 'guides-extra/'])), [LIB_A, LIB_D]);
  });

  it('normalises the path but echoes the input', () => {
    const response = run(['lib'], ['./guides/', 'lib:docs/a.md']);
    assert.deepEqual(sortedIds(response), [LIB_A, LIB_C]);
    assert.deepEqual(response.appliedScope.documents, [
      { project: 'lib', path: 'docs/a.md' },
      { project: 'lib', path: 'guides/' },
    ]);
    assert.deepEqual(response.request.documents, ['./guides/', 'lib:docs/a.md']);
  });

  it('rejects paths outside the repository', () => {
    for (const path of ['../a.md', 'docs/../../a.md', '/docs/a.md', 'C:/docs/a.md']) {
      assert.equal(failure(() => run(['lib'], [path]), 'invalid-request', 'invalid-document').path, path);
    }
    failure(() => run(['lib'], []), 'invalid-request');
    failure(() => run(['lib'], ['']), 'invalid-request');
  });

  it('requires project-qualified entries when the scope has several projects', () => {
    assert.equal(failure(() => run(['lib', 'auxzz'], ['docs/a.md']), 'invalid-request', 'unqualified-document').path, 'docs/a.md');
    assert.equal(failure(() => run(['lib', 'auxzz'], ['lib:docs/a.md', 'other:docs/a.md']), 'invalid-request', 'unqualified-document').path, 'other:docs/a.md');
  });

  it('narrows only the named projects', () => {
    const one = run(['lib', 'auxzz'], ['lib:docs/a.md']);
    assert.deepEqual(sortedIds(one), [AUX_A, AUX_C, LIB_A].sort(compareStrings));
    assert.deepEqual(one.appliedScope.documents, [{ project: 'lib', path: 'docs/a.md' }]);
    const both = run(['lib', 'auxzz'], ['lib:docs/a.md', 'auxzz:guides/']);
    assert.deepEqual(sortedIds(both), [AUX_C, LIB_A].sort(compareStrings));
  });

  it('merges entries that normalise to the same document', () => {
    const response = run(['lib'], ['docs/a.md', './docs/a.md', 'lib:docs/a.md']);
    assert.deepEqual(ids(response), [LIB_A]);
    assert.deepEqual(response.appliedScope.documents, [{ project: 'lib', path: 'docs/a.md' }]);
    assert.deepEqual(response.request.documents, ['docs/a.md', './docs/a.md', 'lib:docs/a.md']);
  });

  it('narrows an allowed link project only when an entry names it', () => {
    // fixture 문서는 기본 종류(reference)라 연결 기본 종류(계약 계열)로는 잡히지 않는다
    const scope: ScopeRequest = { projects: ['lib'], allowedLinks: [{ project: 'auxzz', kinds: ['reference'] }] };
    const open = searchV2(fixture().context, { responseVersion: 2, profile: 'master', scope, query: 'ledger' });
    const linkIds = ids(open).filter((id) => id.startsWith('auxzz:'));
    // 연결 프로젝트 항목이 결과에 나와야 아래 비교가 의미 있다
    assert.ok(linkIds.length > 0, JSON.stringify(ids(open)));
    const narrowed = searchV2(fixture().context, { responseVersion: 2, profile: 'master', scope, query: 'ledger', filters: { documents: ['auxzz:guides/'] } });
    assert.deepEqual(narrowed.appliedScope.documents, [{ project: 'auxzz', path: 'guides/' }]);
    assert.deepEqual(ids(narrowed).filter((id) => id.startsWith('auxzz:')), linkIds.filter((id) => id === AUX_C));
    // 주 프로젝트는 적지 않았으므로 줄이지 않는다
    assert.deepEqual(ids(narrowed).filter((id) => id.startsWith('lib:')).sort(compareStrings), ids(open).filter((id) => id.startsWith('lib:')).sort(compareStrings));
  });

  it('never surfaces documents of projects outside the scope', () => {
    for (const documents of [['docs/'], ['docs/a.md'], ['guides/c.md']]) {
      const response = run(['lib'], documents);
      assert.ok(response.items.every((item) => item.projectId === 'lib'), JSON.stringify(ids(response)));
      assert.equal(JSON.stringify(response).includes('auxzz'), false, documents.join(','));
    }
  });

  it('refuses document filters in v1 requests', () => {
    const detail = failure(() => search(fixture().context, { profile: 'master', query: 'ledger', scope: { projects: ['lib'] }, filters: { documents: ['docs/a.md'] } } as never), 'invalid-request', 'response-version-2-required');
    assert.deepEqual(detail.fields, ['filters.documents']);
  });
});

const LONG = longDoc('wombat', 'quokka');
const SEG = {
  'docs/long.md': LONG,
  'docs/short.md': '# short\n\nquokka short note.\n',
};
const LONG_ID = 'seg:docs/long.md#long';
const SHORT_ID = 'seg:docs/short.md#short';

/** 1400자 문단 열하나. 첫 조각은 제목과 첫 문단이고 나머지는 문단 하나씩이다. 2번과 10번 문단만 같은 글이다. */
const MANY = ['# Many', '', ...['firstx1', 'narwhal', ...Array<string>(7).fill('fillerx'), 'narwhal', 'fillerx'].flatMap((lead) => [`${lead} ${'lorem '.repeat(300)}`.slice(0, 1400), '']), ''].join('\n');

describe('segments in search', () => {
  const fixture = sharedFixture([
    { id: 'seg', files: SEG },
    { id: 'tie', files: { 'docs/many.md': MANY } },
  ]);
  const run = (extra: V2Extra) => searchV2(fixture().context, v2(['seg'], extra));

  function assertSegment(item: OutputItemV2, expected: { ordinal: number; startLine: number; endLine: number; heading: string | null }): void {
    const content = linesOf(LONG, expected.startLine, expected.endLine);
    assert.deepEqual(item.segment, { id: `${LONG_ID}#${expected.ordinal}`, ordinal: expected.ordinal, count: 2, startLine: expected.startLine, endLine: expected.endLine, sha256: sha256(content), heading: expected.heading });
    assert.equal(item.ref.segmentId, item.segment!.id);
    assert.equal(item.ref.segmentSha256, sha256(content));
    assert.equal(item.ref.segmentStartLine, expected.startLine);
    assert.equal(item.ref.segmentEndLine, expected.endLine);
    // 항목 자체의 위치와 해시는 그대로다
    assert.equal(item.provenance.startLine, 4);
    assert.equal(item.provenance.endLine, 12);
    assert.equal(item.ref.startLine, 4);
    assert.equal(item.ref.endLine, 12);
    assert.equal(item.provenance.itemSha256, sha256(linesOf(LONG, 4, 12)));
    assert.ok(item.provenance.excerptStartLine >= expected.startLine && item.provenance.excerptEndLine <= expected.endLine, JSON.stringify(item.provenance));
    assert.equal(item.excerpt, linesOf(LONG, item.provenance.excerptStartLine, item.provenance.excerptEndLine));
  }

  it('names the best segment with exact source lines', () => {
    for (const ranker of ['legacy', 'bm25'] as const) {
      const late = run({ query: 'quokka', segments: true, ranker });
      assertSegment(itemOf(late, LONG_ID), { ordinal: 2, startLine: 10, endLine: 12, heading: null });
      assert.ok(itemOf(late, LONG_ID).excerpt.includes('quokka'));
      const early = run({ query: 'wombat', segments: true, ranker });
      assertSegment(itemOf(early, LONG_ID), { ordinal: 1, startLine: 4, endLine: 8, heading: 'Long' });
      assert.ok(itemOf(early, LONG_ID).excerpt.includes('wombat'));
      assert.deepEqual(late.retrieval.segments, { requested: true, effective: true, chunkerVersion: 'chunk-2', maxChars: 1500 });
      assert.equal(late.request.segments, true);
    }
  });

  it('leaves unsplit items without a segment', () => {
    const response = run({ query: 'quokka', segments: true });
    const short = itemOf(response, SHORT_ID);
    assert.equal(short.segment, null);
    assert.equal(short.ref.segmentId, null);
    assert.equal(short.ref.segmentSha256, null);
  });

  it('returns each item once even when several of its segments match', () => {
    for (const ranker of ['legacy', 'bm25'] as const) {
      const response = run({ query: 'wombat quokka', segments: true, ranker });
      assert.equal(ids(response).filter((id) => id === LONG_ID).length, 1, ranker);
      assert.ok(itemOf(response, LONG_ID).segment !== null);
    }
  });

  it('omits segments when not requested', () => {
    const response = run({ query: 'quokka' });
    const item = itemOf(response, LONG_ID);
    assert.equal(item.segment, null);
    assert.deepEqual([item.ref.segmentId, item.ref.segmentSha256, item.ref.segmentStartLine, item.ref.segmentEndLine], [null, null, null, null]);
    assert.deepEqual(response.retrieval.segments, { requested: false, effective: false, chunkerVersion: 'chunk-2', maxChars: 1500 });
    assert.ok(item.provenance.excerptStartLine >= 4 && item.provenance.excerptEndLine <= 12);
    assert.equal(item.excerpt, linesOf(LONG, item.provenance.excerptStartLine, item.provenance.excerptEndLine));
  });

  it('scores bm25 over segments and unsplit items as the units', () => {
    const { context } = fixture();
    const length = (content: string): number => 2 + wordsOf(content).length;
    const weights = { long: weightOf(context.retrieval, 'policy', 'unverified'), short: weightOf(context.retrieval, 'reference', 'unverified') };
    const shortLength = length('# short\n\nquokka short note.');

    // 조각 단위: 짧은 항목 하나와 긴 항목의 조각 둘이 단위다
    const first = length(linesOf(LONG, 4, 8));
    const second = length(linesOf(LONG, 10, 12));
    const split = { units: 3, averageLength: (shortLength + first + second) / 3, df: { quokka: 2 } };
    const bySegment = run({ query: 'quokka', ranker: 'bm25', segments: true });
    assertScore(itemOf(bySegment, LONG_ID), bm25Expected({ tf: { quokka: 1 }, length: second }, ['quokka'], split) * weights.long);
    assertScore(itemOf(bySegment, SHORT_ID), bm25Expected({ tf: { quokka: 1 }, length: shortLength }, ['quokka'], split) * weights.short);

    // 항목 단위: 긴 항목 전체가 한 단위다
    const whole = length(linesOf(LONG, 4, 12));
    const unsplit = { units: 2, averageLength: (shortLength + whole) / 2, df: { quokka: 2 } };
    const byItem = run({ query: 'quokka', ranker: 'bm25' });
    assertScore(itemOf(byItem, LONG_ID), bm25Expected({ tf: { quokka: 1 }, length: whole }, ['quokka'], unsplit) * weights.long);
    assertScore(itemOf(byItem, SHORT_ID), bm25Expected({ tf: { quokka: 1 }, length: shortLength }, ['quokka'], unsplit) * weights.short);
  });

  it('breaks a tie between segments by the lowest ordinal, also past nine segments', () => {
    for (const ranker of ['legacy', 'bm25'] as const) {
      const response = searchV2(fixture().context, v2(['tie'], { query: 'narwhal', segments: true, ranker }));
      const item = itemOf(response, 'tie:docs/many.md#many');
      assert.equal(item.segment!.count, 11, ranker);
      // 2번과 10번 조각은 내용이 같아 점수가 같다
      assert.equal(item.segment!.ordinal, 2, `${ranker} picked ${item.segment!.id}`);
      assert.equal(item.segment!.startLine, 5, ranker);
    }
  });

  it('keeps segment matching inside the scope so segments of no selected item cannot break a search', (t) => {
    const own = knowledgeFixture(t, [{ id: 'seg', files: SEG }]);
    own.index();
    // 어느 세대의 항목도 아닌 주인을 가진 조각을 SQLite 바인딩 변수 상한(32766)보다 많이 넣는다.
    // 범위·세대 조건을 SQL 밖에서 걸면 이 조각의 주인 목록을 변수로 묶다가 요청이 실패한다
    const db = new DatabaseSync(own.dbPath, { enableForeignKeyConstraints: false });
    try {
      const seed = db.prepare('SELECT segment_pk AS pk FROM item_segments ORDER BY segment_pk LIMIT 1').get() as { pk: number };
      db.exec('BEGIN');
      const copy = db.prepare('INSERT INTO item_segments(item_pk, ordinal, segment_id, start_line, end_line, content, content_sha256, token_count) SELECT ?, 1, segment_id, start_line, end_line, content, content_sha256, token_count FROM item_segments WHERE segment_pk = ?');
      const copyFts = db.prepare('INSERT INTO segments_fts(rowid, key_aliases, title, headings, body, ngram_title, ngram_body) SELECT ?, key_aliases, title, headings, body, ngram_title, ngram_body FROM segments_fts WHERE rowid = ?');
      for (let index = 0; index < 33_000; index++) {
        const pk = Number(copy.run(10_000_000 + index, seed.pk).lastInsertRowid);
        copyFts.run(pk, seed.pk);
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    for (const ranker of ['legacy', 'bm25'] as const) {
      const response = searchV2(own.context, v2(['seg'], { query: 'wombat', segments: true, ranker }));
      assert.equal(itemOf(response, LONG_ID).segment!.ordinal, 1, ranker);
      assert.equal(ids(response).filter((id) => id === LONG_ID).length, 1);
    }
  });

  it('hands off a segment id that get resolves to the same lines', () => {
    const item = itemOf(run({ query: 'quokka', segments: true }), LONG_ID);
    const fetched = getItemV2(fixture().context, { responseVersion: 2, id: item.segment!.id, profile: 'master', scope: { projects: ['seg'] } });
    assert.equal(fetched.item.segmentContent, linesOf(LONG, 10, 12));
    assert.deepEqual(fetched.item.segment, item.segment);
    assert.equal(fetched.item.content, linesOf(LONG, 4, 12));
  });
});

describe('determinism and config hash', () => {
  const fixture = sharedFixture([
    { id: 'plan', files: PLAN },
    { id: 'seg', files: SEG },
  ]);
  const REQUEST = v2(['plan', 'seg'], {
    query: 'cache quokka',
    queries: ['eviction', { key: 'w', text: 'wombat' }, 'Eviction'],
    ranker: 'bm25',
    segments: true,
    quota: { maxPerProject: 3, minPerKind: { policy: 1 } },
    filters: { documents: ['plan:docs/', 'seg:docs/long.md'] },
    budget: { maxItems: 4 },
    limit: 5,
  });

  it('returns byte-identical output for the same request', () => {
    const { context } = fixture();
    const first = JSON.stringify(searchV2(context, REQUEST));
    const second = JSON.stringify(searchV2(context, structuredClone(REQUEST)));
    assert.equal(second, first);
    const parsed = JSON.parse(first) as SearchResponseV2;
    assert.ok(parsed.items.length > 0);
    for (const digest of Object.values(parsed.digests)) assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it('derives digests from the resolved generation, not from how it was selected', () => {
    const base = fixture();
    const sha = git(base.repo('plan'), ['rev-parse', 'HEAD']);
    const responses = [undefined, { generation: 1 }, { generation: 1, exact: true }, { commits: { plan: sha.slice(0, 7) } }].map((version) => searchV2(base.context, version ? { ...REQUEST, version } : REQUEST));
    assert.deepEqual(responses.map((response) => response.index.selection), [
      { by: 'active', exact: false },
      { by: 'generation', exact: false },
      { by: 'generation', exact: true },
      { by: 'commits', exact: false },
    ]);
    for (const response of responses.slice(1)) {
      assert.deepEqual(response.digests, responses[0]!.digests);
      assert.deepEqual(response.request, responses[0]!.request);
    }
  });

  it('changes the config hash and request digest but not the echo when a weight changes', () => {
    const base = fixture();
    const before = searchV2(base.context, REQUEST);
    assert.equal(before.retrieval.configHash, configHashOf(base.context.retrieval, 'master'));
    const changed = retrievalWith(base, 'kind-weights', (raw) => {
      raw.profiles.master.kindWeights.policy = 1.35;
    });
    const after = searchV2(changed, REQUEST);
    assert.notEqual(after.retrieval.configHash, before.retrieval.configHash);
    assert.notEqual(after.digests.request, before.digests.request);
    assert.notEqual(after.digests.result, before.digests.result);
    assert.deepEqual(after.request, before.request);
    assert.deepEqual(after.appliedScope, before.appliedScope);
  });

  it('keeps digests.request apart when queries were cut and equal for document filters that normalise alike', () => {
    const { context } = fixture();
    const limits = QUERY_LIMIT_DEFAULTS;
    // 질의 키 'query' 하나와 목록 질의가 상한을 넘는다. 잘린 요청과 처음부터 잘린 만큼만 보낸 요청은 결과의 limitations가 다르다
    const many = Array.from({ length: limits.maxQueries }, (_, index) => `eviction ${index}`);
    const cut = searchV2(context, v2(['plan'], { query: 'cache', queries: many, overflow: 'truncate' }));
    const preCut = searchV2(context, v2(['plan'], { query: 'cache', queries: many.slice(0, limits.maxQueries - 1) }));
    assert.ok(limitationOf(cut, 'queries-truncated'));
    assert.equal(limitationOf(preCut, 'queries-truncated'), undefined);
    assert.deepEqual(cut.request.queries, preCut.request.queries);
    assert.notEqual(cut.digests.request, preCut.digests.request);

    const long = 'eviction '.repeat(Math.ceil(limits.maxQueryChars / 9) + 10);
    const shortened = searchV2(context, v2(['plan'], { queries: [long], overflow: 'truncate' }));
    const given = searchV2(context, v2(['plan'], { queries: [long.slice(0, limits.maxQueryChars)] }));
    assert.ok(limitationOf(shortened, 'query-text-truncated'));
    assert.notEqual(shortened.digests.request, given.digests.request);

    // 같은 문서로 정규화되는 필터는 같은 요청이다. 원문은 메아리에 그대로 남는다
    const plain = searchV2(context, v2(['plan'], { query: 'cache', filters: { documents: ['docs/'] } }));
    const repeated = searchV2(context, v2(['plan'], { query: 'cache', filters: { documents: ['docs/', './docs/', 'plan:docs/'] } }));
    assert.deepEqual(repeated.appliedScope, plain.appliedScope);
    assert.notDeepEqual(repeated.request.documents, plain.request.documents);
    assert.equal(repeated.digests.request, plain.digests.request);
    assert.equal(repeated.digests.result, plain.digests.result);
  });

  it('changes digests.request when the sources config names a source the generation lacks', () => {
    const { context } = fixture();
    const sources = context.sources!;
    const extra: RetrievalContext = { ...context, sources: { ...sources, sources: [...sources.sources, { ...sources.sources.find((source) => source.project === 'plan')!, id: 'plan-extra' }] } };
    const before = searchV2(context, REQUEST);
    const after = searchV2(extra, REQUEST);
    assert.equal(limitationOf(before, 'source-not-indexed'), undefined);
    assert.deepEqual(limitationOf(after, 'source-not-indexed')?.detail, { sourceIds: ['plan-extra'] });
    assert.notEqual(after.digests.result, before.digests.result);
    // 같은 세대·같은 요청이어도 결과가 다르므로 요청 지문도 달라야 한다
    assert.notEqual(after.digests.request, before.digests.request);
    assert.equal(after.digests.items, before.digests.items);
  });

  it('ignores changes to another profile and explicit defaults', () => {
    const base = fixture();
    const before = JSON.stringify(searchV2(base.context, REQUEST));
    const otherProfile = retrievalWith(base, 'code-weights', (raw) => {
      raw.profiles.code.kindWeights.policy = 1.9;
    });
    assert.equal(JSON.stringify(searchV2(otherProfile, REQUEST)), before);
    const defaults = retrievalWith(base, 'explicit-defaults', (raw) => {
      raw.ranking.bm25 = { k1: 1.2, b: 0.75, fieldWeights: { key_aliases: 4, title: 3, headings: 2, body: 1 } };
      raw.limits = { ...QUERY_LIMIT_DEFAULTS };
    });
    assert.equal(configHashOf(defaults.retrieval, 'master'), configHashOf(base.context.retrieval, 'master'));
    assert.equal(JSON.stringify(searchV2(defaults, REQUEST)), before);
  });
});

const GUARD = {
  'docs/api.md': '---\nkind: contract\n---\n### `CT-9` escrow contract\n\nescrow contract body.\n',
  'docs/rule.md': '# escrow rule\n\nescrow rule body.\n',
  'docs/long.md': longDoc('escrow', 'escrow tail'),
};
const VAULT = {
  'vaultpath/api.md': '---\nkind: contract\n---\n### `CT-9` escrow copy\n\nescrow contract copy.\n',
  'vaultpath/conflict.md': '# escrow vault\n\n- 충돌: `guard:docs/rule.md`\n\nescrow vault body.\n',
  'vaultpath/mand.md': '---\nmandatory: true\n---\n# escrow mandatory\n\nescrow mandatory body.\n',
  'vaultpath/dep.md': '---\nkind: dependency\n---\n# escrow dependency\n\nescrow dependency body.\n',
  'vaultpath/link.md': '# escrow link\n\n- 연결: `guard:docs/api.md`\n\nescrow link body.\n',
  'vaultpath/bulk.md': `# escrow bulk\n\n${'escrow '.repeat(40)}\n`,
};

describe('out-of-scope safety in v2 search', () => {
  const fixture = sharedFixture([
    { id: 'guard', files: GUARD },
    { id: 'vaultsrc', project: 'vaultzz', files: VAULT },
  ]);

  it('never mentions an out-of-scope project anywhere in the response', () => {
    const { context } = fixture();
    const variants: V2Extra[] = [];
    for (const ranker of ['legacy', 'bm25'] as const) {
      for (const segments of [false, true]) {
        variants.push({ query: 'escrow CT-9', ranker, segments });
        variants.push({ queries: ['escrow', 'CT-9', 'Escrow'], ranker, segments, quota: { maxPerProject: 1, minPerKind: { contract: 2 } } });
        variants.push({ query: 'escrow', ranker, segments, budget: { maxItems: 1 }, filters: { documents: ['docs/'] } });
      }
    }
    for (const extra of variants) {
      const response = searchV2(context, v2(['guard'], extra));
      const text = JSON.stringify(response);
      for (const secret of ['vaultzz', 'vaultsrc', 'vaultpath']) assert.equal(text.includes(secret), false, `${secret} leaked: ${JSON.stringify(extra)}`);
      assert.ok(response.items.length > 0);
      assert.equal(response.retrieval.counts.mandatory, 0);
    }

    // 범위 밖 충돌이 실제로 있어야 위 검사가 헛돌지 않는다
    const response = searchV2(context, v2(['guard'], { query: 'escrow CT-9' }));
    const api = itemOf(response, 'guard:docs/api.md#CT-9');
    assert.equal(api.knowledge.status, 'conflicted');
    assert.ok(api.knowledge.conflicts.some((conflict) => conflict.reason === 'duplicate-contract-owner' && conflict.withItemIds.length === 0 && conflict.outOfScopeCount === 1), JSON.stringify(api.knowledge.conflicts));
    const rule = itemOf(response, 'guard:docs/rule.md#escrow-rule');
    assert.ok(rule.knowledge.conflicts.some((conflict) => conflict.reason === 'declared' && conflict.withItemIds.length === 0 && conflict.outOfScopeCount === 1), JSON.stringify(rule.knowledge.conflicts));
  });
});
