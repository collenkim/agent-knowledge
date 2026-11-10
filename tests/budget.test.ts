import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import {
  getItemV2,
  KnowledgeError,
  search,
  searchV2,
  type BudgetReport,
  type ErrorCode,
  type OutputItemV2,
  type ResultGroup,
  type ScopeRequest,
  type SearchRequest,
  type SearchRequestV2,
  type SearchResponseV2,
} from '../src/index.js';
import { RESULT_GROUPS } from '../src/retrieval/types.js';
import { compareStrings } from '../src/util/compare.js';
import { knowledgeFixture, type FixtureSource, type KnowledgeFixture, type RepoFiles } from './helpers.js';

const pad = (n: number): string => String(n).padStart(2, '0');
const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

const MANDATORY_RULES = range(3).map(pad);
const SHIP_DOCS = range(6).map(pad);

const ORDERS: RepoFiles = {
  ...Object.fromEntries(MANDATORY_RULES.map((n) => [`docs/mandatory/m${n}.md`, `# 필수 규칙 ${n}\n\n- 구분: 필수\n${n === '01' ? '- 연결: `LINK-2`\n' : ''}\n필수 규칙 ${n}을 모든 작업에서 지킨다.\n`])),
  'docs/mandatory/ship.md': '# 배송 필수 점검\n\n- 구분: 필수\n\n배송 전에 주소를 다시 확인한다.\n',
  'docs/dep.md': '---\nkind: dependency\n---\n# 결제 의존\n\n결제 서비스 API를 호출한다.\n',
  ...Object.fromEntries(
    SHIP_DOCS.map((n) => [`docs/ship/s${n}.md`, `# 배송 안내 ${n}\n\n${n === '01' ? '- 연결: `LINK-1`\n- 계약: `billing:CON-1`, `billing:CON-9`\n' : ''}- 코드: \`src/ship/s${n}.ts\`\n\n배송 안내 ${n} 본문이다.\n`]),
  ),
  'docs/link.md': '### `LINK-1` 연결 대상\n\n연결 대상 본문이다.\n\n### `LINK-2` 필수 연결 대상\n\n필수 규칙이 가리키는 본문이다.\n',
};

const BILLING: RepoFiles = {
  'docs/open.md': '---\nkind: contract\n---\n### `CON-1` 공개 정산 계약\n\n공개 정산 계약 본문이다.\n',
  'docs/secret.md': '---\nkind: contract\n---\n### `CON-9` 비공개 정산 계약\n\n비공개 계약 본문이다.\n',
};

const OPEN_CONTRACT = 'billing:docs/open.md#CON-1';
const SECRET_CONTRACT = 'billing:docs/secret.md#CON-9';
const SHIP_MANDATORY = 'orders:docs/mandatory/ship.md#배송-필수-점검';
const MANDATORY_IDS = [...MANDATORY_RULES.map((n) => `orders:docs/mandatory/m${n}.md#필수-규칙-${n}`), SHIP_MANDATORY];
const DEPENDENCY_ID = 'orders:docs/dep.md#결제-의존';
const SHIP_IDS = SHIP_DOCS.map((n) => `orders:docs/ship/s${n}.md#배송-안내-${n}`);
const LINK_1 = 'orders:docs/link.md#LINK-1';
const LINK_2 = 'orders:docs/link.md#LINK-2';
const SCOPE: ScopeRequest = { projects: ['orders'], allowedLinks: [{ project: 'billing', itemIds: [OPEN_CONTRACT] }] };

const BULK_COUNT = 30;
const BULK: RepoFiles = {
  ...Object.fromEntries(range(BULK_COUNT).map((n) => [`docs/mandatory/common-rule-${pad(n)}.md`, `# 공통 필수 규칙 ${pad(n)}\n\n- 구분: 필수\n\n공통 필수 규칙 ${pad(n)}의 본문이다.\n`])),
  ...Object.fromEntries(range(BULK_COUNT).map((n) => [`docs/stock/adjustment-${pad(n)}.md`, `# 재고 조정 절차 ${pad(n)}\n\n재고 조정 절차 ${pad(n)}을 설명한다.\n`])),
};
const BULK_SCOPE: ScopeRequest = { projects: ['bulk'] };

const FILLER = '세부 처리 내용을 차례로 적는다. ';
const RETURNS = `# 반품 처리 규정\n\n${range(5)
  .map((n) => `반품 ${n}단계 처리를 설명한다. ${FILLER.repeat(24)}`.trim())
  .join('\n\n')}\n`;
const MANUAL: RepoFiles = {
  'docs/mandatory.md': '# 반송 필수 확인\n\n- 구분: 필수\n\n반송 전에 상자를 확인한다.\n',
  'docs/returns.md': RETURNS,
  'docs/short.md': '# 반품 요약\n\n반품은 이레 안에 받는다.\n',
  'docs/observed.md': '# 반품 관찰 동작\n\n- 구분: 필수\n- 상태: 관찰\n- 코드: `src/returns.ts`\n\n반품 상태 코드는 관찰한 동작이다.\n',
  'src/returns.ts': 'export const RETURNS = true;\n',
};
const MANUAL_SCOPE: ScopeRequest = { projects: ['manual'] };
const RETURNS_ID = 'manual:docs/returns.md#반품-처리-규정';
const OBSERVED_ID = 'manual:docs/observed.md#반품-관찰-동작';

/** 색인을 읽기만 하는 테스트끼리 한 색인을 함께 쓴다. 테스트마다 저장소와 색인을 만들면 파일 전체가 느려진다. */
function sharedFixture(sources: FixtureSource[]): () => KnowledgeFixture {
  const cleanups: (() => void)[] = [];
  let fixture: KnowledgeFixture | undefined;
  before(() => {
    const suite = { after: (fn: () => void) => void cleanups.push(fn) } as unknown as TestContext;
    fixture = knowledgeFixture(suite, sources);
    fixture.index();
  });
  after(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  return () => fixture!;
}

const small = sharedFixture([
  { id: 'orders', files: ORDERS },
  { id: 'billing', files: BILLING },
]);
const bulk = sharedFixture([{ id: 'bulk', files: BULK }]);
const manual = sharedFixture([{ id: 'manual', files: MANUAL }]);

function request(extra: Partial<SearchRequestV2> = {}): SearchRequestV2 {
  return { responseVersion: 2, profile: 'master', query: '배송', scope: SCOPE, ...extra };
}

function bulkRequest(extra: Partial<SearchRequestV2> = {}): SearchRequestV2 {
  return { responseVersion: 2, profile: 'master', query: '재고', scope: BULK_SCOPE, limit: BULK_COUNT, ...extra };
}

const ids = (response: { items: readonly { id: string }[] }): string[] => response.items.map((item) => item.id);
const groupsOf = (response: SearchResponseV2): string[] => response.items.map((item) => item.group);
const codes = (response: SearchResponseV2): string[] => response.limitations.map((limitation) => limitation.code);
const limitationOf = (response: SearchResponseV2, code: string) => response.limitations.find((limitation) => limitation.code === code);
const bytesOf = (response: SearchResponseV2): number => Buffer.byteLength(JSON.stringify(response), 'utf8');
const excerptTotal = (response: SearchResponseV2): number => response.items.reduce((sum, item) => sum + item.excerpt.length, 0);

function failure(fn: () => unknown, code: ErrorCode): KnowledgeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code, `${error.message} ${JSON.stringify(error.detail)}`);
    return error;
  }
  return assert.fail(`expected ${code}`);
}

/** 예산이 없는 응답의 항목을 묶음 우선순위대로 줄 세운다. 묶음 안의 순서는 그대로다. */
function priorityOrder(items: readonly OutputItemV2[], priority: readonly ResultGroup[] = RESULT_GROUPS): OutputItemV2[] {
  return priority.flatMap((group) => items.filter((item) => item.group === group));
}

function canonical(items: readonly OutputItemV2[]): OutputItemV2[] {
  return RESULT_GROUPS.flatMap((group) => items.filter((item) => item.group === group));
}

function omittedOf(item: OutputItemV2): BudgetReport['omitted'][number] {
  return { id: item.id, segmentId: item.segment?.id ?? null, group: item.group as ResultGroup, directRank: item.selection.directRank };
}

function groupCounts(items: readonly { group: string }[]): Record<ResultGroup, number> {
  return { mandatory: items.filter((item) => item.group === 'mandatory').length, dependencies: items.filter((item) => item.group === 'dependencies').length, direct: items.filter((item) => item.group === 'direct').length, linked: items.filter((item) => item.group === 'linked').length };
}

/**
 * 예산 응답이 예산 없는 응답의 우선순위 앞부분과 같은지, 그리고 그 앞부분에서 다시 계산해야 하는 값이 맞는지 본다.
 * baseline은 같은 요청에서 budget만 뺀 응답이다.
 */
function assertPrefix(baseline: SearchResponseV2, budgeted: SearchResponseV2, priority: readonly ResultGroup[] = RESULT_GROUPS): void {
  const ordered = priorityOrder(baseline.items, priority);
  const kept = budgeted.items.length;
  assert.deepEqual(ids(budgeted), ids({ items: canonical(ordered.slice(0, kept)) }));
  assert.deepEqual(
    budgeted.items.map((item) => item.selection.rank),
    range(kept),
  );
  const dropped = ordered.slice(kept);
  assert.equal(budgeted.budget.truncated, dropped.length > 0);
  assert.equal(budgeted.budget.omittedCount, dropped.length);
  assert.deepEqual(budgeted.budget.omitted, dropped.slice(0, 50).map(omittedOf));
  assert.deepEqual(budgeted.retrieval.counts.kept, groupCounts(budgeted.items));
  assert.equal(budgeted.retrieval.directCount, groupCounts(budgeted.items).direct);
  const { kept: _kept, ...before } = budgeted.retrieval.counts;
  const { kept: _baselineKept, ...baselineCounts } = baseline.retrieval.counts;
  assert.deepEqual(before, baselineCounts);
  const truncated = limitationOf(budgeted, 'budget-truncated');
  if (dropped.length === 0) assert.equal(truncated, undefined);
  else assert.deepEqual(truncated!.detail, { count: dropped.length, byGroup: groupCounts(dropped) });
  assert.equal(budgeted.retrieval.outcome, baseline.retrieval.outcome);
  assert.equal(budgeted.status, baseline.status);
  const crowded = baseline.retrieval.outcome === 'matched' && groupCounts(budgeted.items).direct === 0;
  assert.equal(codes(budgeted).includes('direct-crowded-out'), crowded);
  // 남은 항목만으로 절을 다시 만든다. 남은 항목은 정확히 한 절에 한 번 나온다
  const listed = budgeted.sections.flatMap((section) => section.itemIds);
  assert.deepEqual([...listed].sort(compareStrings), ids(budgeted).sort(compareStrings));
  assertSortedLimitations(budgeted);
}

function assertSortedLimitations(response: SearchResponseV2): void {
  const list = codes(response);
  assert.deepEqual(list, [...list].sort(compareStrings));
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

describe('search v2 result groups', () => {
  it('labels every item with its group and designated mandatory flag', () => {
    const response = searchV2(small().context, request());
    assert.equal(response.status, 'ok');
    assert.equal(response.retrieval.outcome, 'matched');
    assert.deepEqual(groupsOf(response), [...Array(4).fill('mandatory'), 'dependencies', ...Array(6).fill('direct'), ...Array(3).fill('linked')]);
    assert.deepEqual(ids(response).slice(0, 4), MANDATORY_IDS);
    assert.equal(response.items[4]!.id, DEPENDENCY_ID);
    assert.deepEqual(ids(response).slice(5, 11), SHIP_IDS);
    assert.deepEqual(ids(response).slice(11).sort(compareStrings), [OPEN_CONTRACT, LINK_1, LINK_2].sort(compareStrings));
    assert.deepEqual(
      response.items.map((item) => item.mandatory),
      response.items.map((item) => MANDATORY_IDS.includes(item.id)),
    );
    assert.deepEqual(
      response.items.map((item) => item.selection.rank),
      range(response.items.length),
    );
    assert.deepEqual(
      response.items.map((item) => item.selection.directRank),
      response.items.map((item) => (item.group === 'direct' ? SHIP_IDS.indexOf(item.id) + 1 : null)),
    );
    assert.deepEqual(response.request.include, { mandatory: true, dependencies: true, links: true });
    assert.deepEqual(response.budget, { limits: { maxItems: null, maxExcerptChars: null, maxResponseBytes: null, priority: [...RESULT_GROUPS] }, truncated: false, exceeded: false, omitted: [], omittedCount: 0 });
    assert.deepEqual(response.retrieval.counts, { mandatory: 4, dependencies: 1, direct: 6, linked: 3, directMatched: 6, supplementaryMatched: 1, kept: { mandatory: 4, dependencies: 1, direct: 6, linked: 3 } });
    assert.ok(!codes(response).some((code) => code.startsWith('budget-')));
  });

  it('drops the mandatory group and lets matching mandatory items compete as direct hits', () => {
    const response = searchV2(small().context, request({ include: { mandatory: false } }));
    assert.deepEqual(response.request.include, { mandatory: false, dependencies: true, links: true });
    assert.ok(!groupsOf(response).includes('mandatory'));
    assert.equal(response.retrieval.counts.mandatory, 0);
    const flagged = response.items.filter((item) => item.mandatory);
    assert.deepEqual(
      flagged.map((item) => [item.id, item.group]),
      [[SHIP_MANDATORY, 'direct']],
    );
    for (const id of MANDATORY_IDS.slice(0, 3)) assert.ok(!ids(response).includes(id), id);
    // 필수 항목 m01만 가리키는 연결은 필수 묶음이 없으면 펼치지 않는다
    assert.ok(!ids(response).includes(LINK_2));
    assert.ok(ids(response).includes(LINK_1));
    assert.deepEqual(response.sections.find((section) => section.id === 'mandatory')!.itemIds, []);
    assert.ok(!codes(response).includes('mandatory-truncated'));
  });

  it('drops the dependency group', () => {
    const response = searchV2(small().context, request({ include: { dependencies: false } }));
    assert.ok(!groupsOf(response).includes('dependencies'));
    assert.ok(!ids(response).includes(DEPENDENCY_ID));
    assert.equal(response.retrieval.counts.dependencies, 0);
    assert.deepEqual(response.sections.find((section) => section.id === 'dependencies')!.itemIds, []);
    assert.ok(groupsOf(response).includes('mandatory'));
  });

  it('drops linked items and marks their links as not included', () => {
    const response = searchV2(small().context, request({ include: { links: false } }));
    assert.ok(!groupsOf(response).includes('linked'));
    assert.equal(response.retrieval.counts.linked, 0);
    for (const id of [LINK_1, LINK_2, OPEN_CONTRACT]) assert.ok(!ids(response).includes(id), id);
    const first = response.items.find((item) => item.id === SHIP_IDS[0])!;
    const link = first.links.find((candidate) => candidate.targetItemId === LINK_1)!;
    assert.equal(link.included, false);
    assert.equal(link.inScope, true);
  });

  it('can turn every supplementary group off at once', () => {
    const response = searchV2(small().context, request({ include: { mandatory: false, dependencies: false, links: false } }));
    assert.ok(response.items.every((item) => item.group === 'direct'));
    assert.deepEqual(ids(response).sort(compareStrings), [SHIP_MANDATORY, ...SHIP_IDS].sort(compareStrings));
    assert.equal(response.retrieval.outcome, 'matched');
  });
});

describe('search v2 outcome', () => {
  it('reports supplementary-only with status ok when no direct match but mandatory items exist', () => {
    const response = searchV2(small().context, request({ query: 'zzqx' }));
    assert.equal(response.status, 'ok');
    assert.equal(response.retrieval.outcome, 'supplementary-only');
    assert.ok(response.items.length > 0);
    assert.ok(response.items.every((item) => item.group !== 'direct'));
    assert.equal(response.retrieval.counts.direct, 0);
    assert.equal(response.retrieval.counts.directMatched, 0);
    assert.ok(codes(response).includes('no-query-matches'));
    assert.ok(!codes(response).includes('direct-crowded-out'));
  });

  it('reports matched when the only match is already in the mandatory group, and marks that item', () => {
    const { context } = small();
    // '주소를'은 필수 항목 ship.md에만 있다. 필수 묶음에 이미 들어 있어 직접 결과에는 다시 넣지 않는다
    const response = searchV2(context, request({ query: '주소를' }));
    assert.equal(response.status, 'ok');
    assert.equal(response.retrieval.outcome, 'matched');
    assert.equal(response.retrieval.counts.direct, 0);
    assert.equal(response.retrieval.counts.directMatched, 0);
    assert.equal(response.retrieval.counts.supplementaryMatched, 1);
    assert.ok(!codes(response).includes('no-query-matches'));
    assert.ok(!codes(response).includes('direct-crowded-out'));
    const ship = response.items.find((item) => item.id === SHIP_MANDATORY)!;
    assert.equal(ship.group, 'mandatory');
    assert.equal(ship.selection.matchedQueries.length, 1);
    assert.deepEqual(ship.selection.reasons, ['mandatory']);
    assert.deepEqual(ship.selection.matchedTerms, []);
    for (const item of response.items.filter((candidate) => candidate.id !== SHIP_MANDATORY)) assert.deepEqual(item.selection.matchedQueries, [], item.id);
    // 형식 1 출력은 바꾸지 않는다
    const v1 = search(context, { profile: 'master', query: '주소를', scope: SCOPE });
    assert.ok(v1.limitations.some((limitation) => limitation.code === 'no-query-matches'));
    // 필수 묶음을 끄면 같은 항목이 직접 결과가 된다
    const without = searchV2(context, request({ query: '주소를', include: { mandatory: false } }));
    assert.equal(without.retrieval.outcome, 'matched');
    assert.equal(without.retrieval.counts.supplementaryMatched, 0);
    assert.deepEqual(without.items.filter((item) => item.group === 'direct').map((item) => item.id), [SHIP_MANDATORY]);
  });

  it('reports supplementary-only for dependencies alone', () => {
    const response = searchV2(small().context, request({ query: 'zzqx', include: { mandatory: false, links: false } }));
    assert.equal(response.status, 'ok');
    assert.equal(response.retrieval.outcome, 'supplementary-only');
    assert.deepEqual(ids(response), [DEPENDENCY_ID]);
  });

  it('reports no-results only when nothing at all comes back', () => {
    const { context } = small();
    const empty = searchV2(context, request({ query: 'zzqx', include: { mandatory: false, dependencies: false, links: false } }));
    assert.equal(empty.status, 'no-results');
    assert.equal(empty.retrieval.outcome, 'no-results');
    assert.deepEqual(empty.items, []);
    assert.ok(!codes(empty).includes('no-query-matches'));
    assert.ok(!codes(empty).includes('direct-crowded-out'));
    assert.equal(empty.budget.truncated, false);
    // 필수 자료만 있는 응답과 아무것도 없는 응답을 상태와 outcome으로 가를 수 있다
    const mandatoryOnly = searchV2(context, request({ query: 'zzqx', include: { dependencies: false, links: false } }));
    assert.deepEqual(ids(mandatoryOnly), MANDATORY_IDS);
    assert.notEqual(mandatoryOnly.status, empty.status);
    assert.notEqual(mandatoryOnly.retrieval.outcome, empty.retrieval.outcome);
  });

  it('decides outcome before the budget so a fully cut response is not no-results', () => {
    const { context } = small();
    const supplementary = searchV2(context, request({ query: 'zzqx', budget: { maxExcerptChars: 1 } }));
    assert.deepEqual(supplementary.items, []);
    assert.equal(supplementary.status, 'ok');
    assert.equal(supplementary.retrieval.outcome, 'supplementary-only');
    assert.equal(supplementary.budget.truncated, true);
    assert.ok(!codes(supplementary).includes('direct-crowded-out'));
    const matched = searchV2(context, request({ budget: { maxExcerptChars: 1 } }));
    assert.deepEqual(matched.items, []);
    assert.equal(matched.status, 'ok');
    assert.equal(matched.retrieval.outcome, 'matched');
    assert.ok(codes(matched).includes('direct-crowded-out'));
  });
});

describe('search v2 budget maxItems and priority', () => {
  it('keeps a prefix in the default priority order and says when direct hits were crowded out', () => {
    const { context } = small();
    const baseline = searchV2(context, request());
    const response = searchV2(context, request({ budget: { maxItems: 5 } }));
    assertPrefix(baseline, response);
    assert.deepEqual(ids(response), [...MANDATORY_IDS, DEPENDENCY_ID]);
    assert.equal(response.retrieval.outcome, 'matched');
    assert.equal(response.retrieval.directCount, 0);
    assert.deepEqual(limitationOf(response, 'direct-crowded-out')!.detail, { directMatched: 6 });
    // 직접 일치가 있었으므로 질의 불일치 안내는 내지 않는다
    assert.ok(!codes(response).includes('no-query-matches'));
    assert.deepEqual(
      response.budget.omitted.map((entry) => [entry.group, entry.directRank]),
      [...SHIP_IDS.map((_, index) => ['direct', index + 1]), ['linked', null], ['linked', null], ['linked', null]],
    );
    assert.deepEqual(response.budget.limits, { maxItems: 5, maxExcerptChars: null, maxResponseBytes: null, priority: [...RESULT_GROUPS] });
    assert.deepEqual(response.request.budget, { maxItems: 5 });
  });

  it('keeps direct items first under a custom priority and renders kept items in canonical order', () => {
    const { context } = small();
    const baseline = searchV2(context, request());
    const priority: ResultGroup[] = ['direct', 'mandatory', 'dependencies', 'linked'];
    const three = searchV2(context, request({ budget: { maxItems: 3, priority } }));
    assertPrefix(baseline, three, priority);
    assert.deepEqual(ids(three), SHIP_IDS.slice(0, 3));
    assert.deepEqual(
      three.items.map((item) => item.selection.directRank),
      [1, 2, 3],
    );
    assert.ok(!codes(three).includes('direct-crowded-out'));
    assert.deepEqual(three.budget.limits.priority, priority);

    const eight = searchV2(context, request({ budget: { maxItems: 8, priority } }));
    assertPrefix(baseline, eight, priority);
    assert.deepEqual(ids(eight), [...MANDATORY_IDS.slice(0, 2), ...SHIP_IDS]);
    assert.deepEqual(groupsOf(eight), ['mandatory', 'mandatory', ...Array(6).fill('direct')]);
  });

  it('keeps the right prefix for every priority order', () => {
    const { context } = small();
    const baseline = searchV2(context, request());
    for (const priority of permutations(RESULT_GROUPS)) {
      for (const maxItems of [1, 4, 9, 13, 50]) {
        const response = searchV2(context, request({ budget: { maxItems, priority } }));
        assert.equal(response.items.length, Math.min(maxItems, baseline.items.length), `${priority.join(',')} ${maxItems}`);
        assertPrefix(baseline, response, priority);
      }
    }
  });

  it('does not truncate when maxItems covers everything', () => {
    const { context } = small();
    const baseline = searchV2(context, request());
    const response = searchV2(context, request({ budget: { maxItems: 1000 } }));
    assert.deepEqual(ids(response), ids(baseline));
    assert.equal(response.budget.truncated, false);
    assert.equal(response.budget.omittedCount, 0);
    assert.ok(!codes(response).includes('budget-truncated'));
  });

  it('does not reorder or cut anything with a priority alone', () => {
    const { context } = small();
    const baseline = searchV2(context, request());
    const priority: ResultGroup[] = ['linked', 'direct', 'dependencies', 'mandatory'];
    const response = searchV2(context, request({ budget: { priority } }));
    assert.deepEqual(ids(response), ids(baseline));
    assert.deepEqual(response.budget.limits, { maxItems: null, maxExcerptChars: null, maxResponseBytes: null, priority });
    assert.equal(response.budget.truncated, false);
  });

  it('reports pre-budget counts next to kept counts', () => {
    const { context } = small();
    const response = searchV2(context, request({ limit: 2, budget: { maxItems: 6 } }));
    assert.deepEqual(response.retrieval.counts, { mandatory: 4, dependencies: 1, direct: 2, linked: 3, directMatched: 6, supplementaryMatched: 1, kept: { mandatory: 4, dependencies: 1, direct: 1, linked: 0 } });
    assert.deepEqual(limitationOf(response, 'budget-truncated')!.detail, { count: 4, byGroup: { mandatory: 0, dependencies: 0, direct: 1, linked: 3 } });
    assert.deepEqual(response.retrieval.composition.direct.byProject, { orders: 1 });
    assert.deepEqual(response.retrieval.composition.supplementary.byProject, { orders: 5 });
  });
});

describe('search v2 budget recomputes derived fields', () => {
  it('rebuilds sections, links.included and codeLocations from kept items only', () => {
    const { context } = small();
    const codeRequest = (budget?: SearchRequestV2['budget']): SearchRequestV2 => request({ profile: 'code', include: { mandatory: false }, ...(budget ? { budget } : {}) });
    const full = searchV2(context, codeRequest());
    const linkOf = (response: SearchResponseV2, target: string) => response.items.find((item) => item.id === SHIP_IDS[0])!.links.find((link) => link.targetItemId === target)!;
    assert.ok(ids(full).includes(LINK_1));
    assert.equal(linkOf(full, LINK_1).included, true);
    assert.equal(linkOf(full, OPEN_CONTRACT).included, true);
    assert.deepEqual(
      full.codeLocations.map((location) => location.path),
      SHIP_DOCS.map((n) => `src/ship/s${n}.ts`),
    );

    const response = searchV2(context, codeRequest({ maxItems: 2, priority: ['direct', 'mandatory', 'dependencies', 'linked'] }));
    assertPrefix(full, response, ['direct', 'mandatory', 'dependencies', 'linked']);
    const kept = new Set(ids(response));
    assert.ok(kept.has(SHIP_IDS[0]!));
    assert.equal(linkOf(response, LINK_1).included, false);
    assert.equal(linkOf(response, LINK_1).inScope, true);
    assert.equal(linkOf(response, OPEN_CONTRACT).included, false);
    assert.ok(response.codeLocations.length > 0);
    for (const location of response.codeLocations) for (const id of location.fromItemIds) assert.ok(kept.has(id), id);
    assert.deepEqual(
      response.codeLocations.map((location) => location.path).sort(compareStrings),
      response.items.flatMap((item) => item.links.filter((link) => link.relation === 'code').map((link) => link.target)).sort(compareStrings),
    );
    for (const section of response.sections) for (const id of section.itemIds) assert.ok(kept.has(id), `${section.id} ${id}`);
    assert.deepEqual(response.retrieval.composition.supplementary, { byProject: {}, byKind: {} });
  });

  it('counts unconfirmed results over kept items only', () => {
    const { context } = small();
    const response = searchV2(context, request({ budget: { maxItems: 2 } }));
    assert.deepEqual(limitationOf(response, 'unconfirmed-results')!.detail, { count: 2 });
  });
});

describe('search v2 budget maxExcerptChars', () => {
  it('keeps the longest priority prefix whose excerpts fit', () => {
    const { context } = small();
    const baseline = searchV2(context, request());
    const lengths = baseline.items.map((item) => item.excerpt.length);
    const prefixSums = lengths.map((_, index) => lengths.slice(0, index + 1).reduce((sum, length) => sum + length, 0));
    const limits = [1, lengths[0]!, lengths[0]! + lengths[1]! - 1, prefixSums[4]!, prefixSums[7]! + 1, prefixSums.at(-1)!, prefixSums.at(-1)! + 1000];
    for (const maxExcerptChars of limits) {
      const response = searchV2(context, request({ budget: { maxExcerptChars } }));
      const expected = prefixSums.filter((sum) => sum <= maxExcerptChars).length;
      assert.equal(response.items.length, expected, String(maxExcerptChars));
      assert.ok(excerptTotal(response) <= maxExcerptChars, String(maxExcerptChars));
      assert.equal(response.budget.exceeded, false);
      assert.ok(!codes(response).includes('budget-exceeded'));
      assertPrefix(baseline, response);
    }
  });

  it('stops at the first item that does not fit instead of skipping ahead', () => {
    const { context } = small();
    const priority: ResultGroup[] = ['direct', 'linked', 'mandatory', 'dependencies'];
    const baseline = searchV2(context, request());
    const ordered = priorityOrder(baseline.items, priority);
    // 첫 항목보다 한 글자 적으면 뒤의 짧은 항목이 들어갈 자리가 있어도 아무것도 남기지 않는다
    const limit = ordered[0]!.excerpt.length - 1;
    assert.ok(ordered.slice(1).some((item) => item.excerpt.length <= limit));
    const response = searchV2(context, request({ budget: { maxExcerptChars: limit, priority } }));
    assert.deepEqual(response.items, []);
    assertPrefix(baseline, response, priority);
  });

  it('measures segment excerpts, not whole items, in segment mode', () => {
    const { context } = manual();
    const segmented = (budget?: SearchRequestV2['budget']): SearchRequestV2 => ({ responseVersion: 2, profile: 'master', query: '반품', scope: MANUAL_SCOPE, segments: true, ...(budget ? { budget } : {}) });
    const baseline = searchV2(context, segmented());
    const returns = baseline.items.find((item) => item.id === RETURNS_ID)!;
    assert.notEqual(returns.segment, null);
    const priority: ResultGroup[] = ['direct', 'mandatory', 'dependencies', 'linked'];
    const ordered = priorityOrder(baseline.items, priority);
    const limit = ordered[0]!.excerpt.length + ordered[1]!.excerpt.length;
    const response = searchV2(context, segmented({ maxExcerptChars: limit, priority }));
    assert.equal(response.items.length, 2);
    assert.ok(excerptTotal(response) <= limit);
    assertPrefix(baseline, response, priority);
  });
});

describe('search v2 budget maxResponseBytes', () => {
  it('keeps the compact JSON within the limit unless even zero items exceed it', () => {
    for (const [fixture, make] of [
      [small, request],
      [bulk, bulkRequest],
    ] as const) {
      const { context } = fixture();
      const baseline = searchV2(context, make());
      const seen = { exceeded: 0, truncated: 0, whole: 0 };
      for (const maxResponseBytes of [4096, 5000, 6500, 8000, 12000, 20000, 40000, 10_000_000]) {
        const response = searchV2(context, make({ budget: { maxResponseBytes } }));
        const label = `${baseline.items[0]!.projectId} ${maxResponseBytes}`;
        if (response.budget.exceeded) {
          seen.exceeded++;
          assert.deepEqual(response.items, [], label);
          assert.ok(codes(response).includes('budget-exceeded'), label);
        } else {
          seen[response.budget.truncated ? 'truncated' : 'whole']++;
          assert.ok(bytesOf(response) <= maxResponseBytes, `${label}: ${bytesOf(response)}`);
          assert.ok(!codes(response).includes('budget-exceeded'), label);
        }
        assertPrefix(baseline, response);
      }
      assert.ok(seen.truncated > 0 && seen.whole > 0, JSON.stringify(seen));
      if (fixture === bulk) assert.ok(seen.exceeded > 0, JSON.stringify(seen));
    }
  });

  it('keeps the largest prefix that fits', () => {
    const { context } = small();
    const baseline = searchV2(context, request());
    const sizes = range(baseline.items.length).map((maxItems) => bytesOf(searchV2(context, request({ budget: { maxItems } }))));
    let checked = 0;
    for (let keep = 1; keep < baseline.items.length; keep++) {
      const limit = sizes[keep - 1]! + 64;
      if (limit < 4096) continue;
      // 요청 반향과 limits의 숫자 차이는 수십 바이트이고 항목 하나는 그보다 훨씬 크다
      assert.ok(sizes[keep]! - sizes[keep - 1]! > 128);
      const response = searchV2(context, request({ budget: { maxResponseBytes: limit } }));
      assert.equal(response.items.length, keep, `limit ${limit}`);
      assert.ok(bytesOf(response) <= limit);
      assert.equal(response.budget.exceeded, false);
      checked++;
    }
    assert.ok(checked >= 5, `checked ${checked}`);
  });

  it('returns zero items and budget-exceeded when the envelope alone is too big', () => {
    const { context } = bulk();
    const baseline = searchV2(context, bulkRequest());
    const total = baseline.items.length;
    assert.equal(total, BULK_COUNT * 2);
    const response = searchV2(context, bulkRequest({ budget: { maxResponseBytes: 4096 } }));
    assert.equal(response.budget.exceeded, true);
    assert.equal(response.budget.truncated, true);
    assert.deepEqual(response.items, []);
    assert.ok(bytesOf(response) > 4096);
    assert.deepEqual(limitationOf(response, 'budget-exceeded')!.detail, { maxResponseBytes: 4096 });
    assert.deepEqual(limitationOf(response, 'budget-truncated')!.detail, { count: total, byGroup: { mandatory: BULK_COUNT, dependencies: 0, direct: BULK_COUNT, linked: 0 } });
    assert.equal(response.budget.omittedCount, total);
    assert.equal(response.budget.omitted.length, 50);
    assert.deepEqual(response.retrieval.counts.kept, { mandatory: 0, dependencies: 0, direct: 0, linked: 0 });
    assert.ok(response.sections.every((section) => section.itemIds.length === 0));
    assert.equal(response.status, 'ok');
    assert.equal(response.retrieval.outcome, 'matched');
    assert.ok(codes(response).includes('direct-crowded-out'));
    assert.ok(!codes(response).includes('no-query-matches'));
    assertPrefix(baseline, response);
  });

  it('combines every limit as the shortest prefix', () => {
    const { context } = small();
    const baseline = searchV2(context, request());
    for (const maxItems of [1, 4, 9]) {
      for (const maxExcerptChars of [60, 250, 100_000]) {
        for (const maxResponseBytes of [6000, 12_000, 100_000]) {
          const budget = { maxItems, maxExcerptChars, maxResponseBytes };
          const response = searchV2(context, request({ budget }));
          const label = JSON.stringify(budget);
          assert.ok(response.items.length <= maxItems, label);
          assert.ok(excerptTotal(response) <= maxExcerptChars, label);
          if (!response.budget.exceeded) assert.ok(bytesOf(response) <= maxResponseBytes, label);
          const alone = Math.min(...[{ maxItems }, { maxExcerptChars }].map((single) => searchV2(context, request({ budget: single })).items.length));
          assert.ok(response.items.length <= alone, label);
          if (maxResponseBytes === 100_000) assert.equal(response.items.length, alone, label);
          assertPrefix(baseline, response);
        }
      }
    }
  });
});

describe('search v2 omitted list', () => {
  it('caps the omitted list at 50 entries and counts the rest', () => {
    const { context } = bulk();
    const baseline = searchV2(context, bulkRequest());
    const response = searchV2(context, bulkRequest({ budget: { maxItems: 2 } }));
    assertPrefix(baseline, response);
    assert.equal(response.budget.omitted.length, 50);
    assert.equal(response.budget.omittedCount, BULK_COUNT * 2 - 2);
    assert.equal(limitationOf(response, 'budget-truncated')!.detail.count, BULK_COUNT * 2 - 2);
    assert.deepEqual(
      response.budget.omitted.map((entry) => [entry.group, entry.directRank]),
      [...Array.from({ length: BULK_COUNT - 2 }, () => ['mandatory', null]), ...range(50 - (BULK_COUNT - 2)).map((rank) => ['direct', rank])],
    );
  });

  it('lists only ids that getItemV2 can fetch in the same scope and generation', () => {
    for (const [fixture, make, scope, profile] of [
      [small, request, SCOPE, 'master'],
      [small, request, SCOPE, 'code'],
      [bulk, bulkRequest, BULK_SCOPE, 'master'],
    ] as const) {
      const { context } = fixture();
      const response = searchV2(context, make({ profile, budget: { maxItems: 1 } }));
      assert.ok(response.budget.omitted.length > 0);
      for (const entry of response.budget.omitted) {
        const fetched = getItemV2(context, { responseVersion: 2, id: entry.id, profile, scope, version: { generation: response.index.generation } });
        assert.equal(fetched.item.id, entry.id);
        assert.equal(fetched.item.group, 'lookup');
        assert.equal(getItemV2(context, { responseVersion: 2, id: entry.id, profile, scope }).item.id, entry.id);
      }
    }
  });

  it('includes allowed linked items but never out-of-scope ones', () => {
    const { context } = small();
    for (const budget of [{ maxItems: 1 }, { maxItems: 12 }, { maxExcerptChars: 1 }, { maxResponseBytes: 4096 }] as const) {
      const response = searchV2(context, request({ budget }));
      const omitted = response.budget.omitted.map((entry) => entry.id);
      const listed = [...ids(response), ...omitted];
      assert.ok(listed.includes(OPEN_CONTRACT), JSON.stringify(budget));
      const text = JSON.stringify(response);
      assert.ok(!text.includes(SECRET_CONTRACT), JSON.stringify(budget));
      assert.ok(!text.includes('docs/secret.md'), JSON.stringify(budget));
      for (const id of listed) assert.ok(id.startsWith('orders:') || id === OPEN_CONTRACT, id);
    }
    failure(() => getItemV2(context, { responseVersion: 2, id: SECRET_CONTRACT, profile: 'master', scope: SCOPE }), 'not-found');
  });

  it('names the best segment of an omitted segmented item and get resolves it', () => {
    const { context } = manual();
    const response = searchV2(context, { responseVersion: 2, profile: 'master', query: '반품', scope: MANUAL_SCOPE, segments: true, budget: { maxItems: 1 } });
    assert.deepEqual(groupsOf(response), ['mandatory']);
    const entry = response.budget.omitted.find((candidate) => candidate.id === RETURNS_ID)!;
    assert.equal(entry.group, 'direct');
    assert.ok(entry.segmentId !== null && entry.segmentId.startsWith(`${RETURNS_ID}#`), String(entry.segmentId));
    const fetched = getItemV2(context, { responseVersion: 2, id: entry.segmentId, profile: 'master', scope: MANUAL_SCOPE, version: { generation: response.index.generation } });
    assert.equal(fetched.item.id, RETURNS_ID);
    assert.equal(fetched.item.segment!.id, entry.segmentId);
    assert.ok(fetched.item.segmentContent !== null && fetched.item.segmentContent.length > 0);
    assert.ok(fetched.item.content.includes(fetched.item.segmentContent));
    const item = getItemV2(context, { responseVersion: 2, id: entry.id, profile: 'master', scope: MANUAL_SCOPE });
    assert.equal(item.item.segment, null);
  });
});

describe('search v2 limitations', () => {
  it('sorts limitations by code in every budget situation', () => {
    const { context } = small();
    const cases: Partial<SearchRequestV2>[] = [
      {},
      { budget: { maxItems: 1 } },
      { budget: { maxExcerptChars: 1 } },
      { budget: { maxResponseBytes: 4096 } },
      { query: 'zzqx' },
      { query: 'zzqx', budget: { maxItems: 2 } },
      { queries: ['배송', '배송 '], budget: { maxItems: 3 } },
      { quota: { minPerKind: { policy: 1 } }, budget: { maxItems: 3 } },
    ];
    for (const extra of cases) {
      const response = searchV2(context, request(extra));
      assertSortedLimitations(response);
      assert.equal(new Set(codes(response)).size, codes(response).length, JSON.stringify(extra));
    }
    const notes = searchV2(context, request({ queries: ['배송', '배송 '], quota: { minPerKind: { policy: 1 } }, budget: { maxItems: 3 } }));
    for (const code of ['budget-truncated', 'direct-crowded-out', 'queries-deduplicated', 'quota-unmet']) assert.ok(codes(notes).includes(code), code);
  });

  it('keeps no-query-matches only when the query matched nothing', () => {
    const { context } = small();
    const crowded = searchV2(context, request({ budget: { maxItems: 1 } }));
    assert.deepEqual(ids(crowded), [MANDATORY_IDS[0]]);
    assert.ok(!codes(crowded).includes('no-query-matches'));
    assert.ok(codes(crowded).includes('direct-crowded-out'));
    const unmatched = searchV2(context, request({ query: 'zzqx', budget: { maxItems: 1 } }));
    assert.ok(codes(unmatched).includes('no-query-matches'));
    assert.ok(!codes(unmatched).includes('direct-crowded-out'));
  });
});

describe('search v2 for the code agent', () => {
  it('drops mandatory duplicates for the code agent while master-like requests keep them', () => {
    const { context } = small();
    const codeScope: ScopeRequest = { projects: ['orders'] };
    for (const profile of ['master', 'code'] as const) {
      const keeps = searchV2(context, request({ profile, scope: codeScope }));
      assert.deepEqual(
        keeps.items.filter((item) => item.group === 'mandatory').map((item) => item.id),
        MANDATORY_IDS,
        profile,
      );
      assert.equal(new Set(ids(keeps)).size, keeps.items.length);
      assert.ok(keeps.items.filter((item) => item.group === 'direct').every((item) => !item.mandatory), profile);
    }
    const master = searchV2(context, request({ scope: codeScope }));
    const code = searchV2(context, request({ profile: 'code', scope: codeScope, include: { mandatory: false } }));
    assert.ok(!groupsOf(code).includes('mandatory'));
    // 이미 받은 필수 자료와 겹치는 항목은 mandatory 표시로 걸러 낼 수 있다
    const duplicates = code.items.filter((item) => MANDATORY_IDS.includes(item.id));
    assert.deepEqual(
      duplicates.map((item) => [item.id, item.group, item.mandatory]),
      [[SHIP_MANDATORY, 'direct', true]],
    );
    const fresh = code.items.filter((item) => !item.mandatory).map((item) => item.id);
    const masterMandatory = master.items.filter((item) => item.group === 'mandatory').map((item) => item.id);
    assert.ok(fresh.every((id) => !masterMandatory.includes(id)));
    assert.ok(fresh.length > 0);
    // 필수 묶음을 빼도 예산은 남은 묶음에서 그대로 앞부분을 남긴다
    const budgeted = searchV2(context, request({ profile: 'code', scope: codeScope, include: { mandatory: false }, budget: { maxItems: 3 } }));
    assertPrefix(code, budgeted);
  });

  it('flags a designated mandatory item that the mandatory group leaves out', () => {
    const { context } = manual();
    const response = searchV2(context, { responseVersion: 2, profile: 'master', query: '반품', scope: MANUAL_SCOPE });
    const observed = response.items.find((item) => item.id === OBSERVED_ID)!;
    assert.equal(observed.knowledge.status, 'observed_behavior');
    assert.equal(observed.knowledge.confirmed, false);
    // 관찰 상태는 필수 묶음에 들지 않지만 원본의 필수 지정은 그대로 알린다
    assert.equal(observed.group, 'direct');
    assert.equal(observed.mandatory, true);
    assert.deepEqual(
      response.items.filter((item) => item.group === 'mandatory').map((item) => item.id),
      ['manual:docs/mandatory.md#반송-필수-확인'],
    );
  });
});

describe('search v2 budget validation', () => {
  it('rejects malformed budgets', () => {
    const { context } = small();
    const malformed: unknown[] = [
      { maxItems: 0 },
      { maxItems: 1.5 },
      { maxExcerptChars: 0 },
      { maxResponseBytes: 4095 },
      { priority: ['direct', 'direct', 'mandatory', 'linked'] },
      { priority: ['direct', 'mandatory', 'linked'] },
      { priority: [...RESULT_GROUPS, 'direct'] },
      { priority: ['direct', 'mandatory', 'dependencies', 'lookup'] },
      { maxTokens: 10 },
    ];
    for (const budget of malformed) {
      const error = failure(() => searchV2(context, { ...request(), budget } as unknown as SearchRequestV2), 'invalid-request');
      const issues = (error.detail as { issues: { path: string }[] }).issues;
      assert.ok(issues.length > 0 && issues.every((issue) => issue.path.startsWith('budget')), JSON.stringify(error.detail));
    }
    failure(() => searchV2(context, { ...request(), include: { mandatory: false, extra: true } } as unknown as SearchRequestV2), 'invalid-request');
    assert.equal(searchV2(context, request({ budget: { maxResponseBytes: 4096 } })).budget.limits.maxResponseBytes, 4096);
  });

  it('rejects budget and include in a version 1 request instead of ignoring them', () => {
    const { context } = small();
    const v1 = { profile: 'master', query: '배송', scope: SCOPE };
    const budget = failure(() => search(context, { ...v1, budget: { maxItems: 1 } } as unknown as SearchRequest), 'invalid-request');
    assert.deepEqual(budget.detail, { reason: 'response-version-2-required', fields: ['budget'] });
    const both = failure(() => search(context, { ...v1, include: { mandatory: false }, budget: { maxItems: 1 } } as unknown as SearchRequest), 'invalid-request');
    assert.deepEqual(both.detail, { reason: 'response-version-2-required', fields: ['include', 'budget'] });
  });
});
