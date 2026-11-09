import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { getItem, KINDS, KnowledgeError, loadRetrievalConfig, search, type ErrorCode, type RetrievalConfig, type RetrievalContext, type SearchRequest, type SearchResponse } from '../src/index.js';
import { git, knowledgeFixture, RETRIEVAL_CONFIG_PATH, tempSpace, type FixtureSource, type KnowledgeFixture } from './helpers.js';

function failure(fn: () => unknown, code: ErrorCode, reason?: string): KnowledgeError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code, `${error.message} ${JSON.stringify(error.detail)}`);
    if (reason !== undefined) assert.equal((error.detail as { reason?: string }).reason, reason);
    return error;
  }
  return assert.fail(`expected ${code}`);
}

function built(t: TestContext, sources: FixtureSource[]): KnowledgeFixture {
  const fixture = knowledgeFixture(t, sources);
  fixture.index();
  return fixture;
}

function withProfile(context: RetrievalContext, name: 'master' | 'code', change: Partial<RetrievalConfig['profiles']['master']>): RetrievalContext {
  const { retrieval } = context;
  return { ...context, retrieval: { ...retrieval, profiles: { ...retrieval.profiles, [name]: { ...retrieval.profiles[name], ...change } } } };
}

const ids = (response: SearchResponse): string[] => response.items.map((item) => item.id);
const limitation = (response: SearchResponse, code: string): Record<string, unknown> | undefined => response.limitations.find((entry) => entry.code === code)?.detail;
const WORD = '공통단어';
const doc = (kind: string, title: string, extra = ''): string => `---\nkind: ${kind}\n---\n# ${title}\n\n${extra}${WORD} 본문이다.\n`;
const master = (extra: Partial<SearchRequest> = {}): SearchRequest => ({ profile: 'master', query: WORD, scope: { projects: ['orders'] }, ...extra });
const code = (extra: Partial<SearchRequest> = {}): SearchRequest => ({ profile: 'code', query: WORD, scope: { projects: ['orders'] }, ...extra });

describe('retrieval config', () => {
  function variant(t: TestContext, change: (config: RetrievalConfig) => void): string {
    const config = parse(readFileSync(RETRIEVAL_CONFIG_PATH, 'utf8')) as RetrievalConfig;
    change(config);
    const path = tempSpace(t).path('retrieval.yaml');
    writeFileSync(path, stringify(config));
    return path;
  }

  it('loads the shipped configuration', () => {
    const config = loadRetrievalConfig(RETRIEVAL_CONFIG_PATH);
    assert.equal(config.profiles.code.requiresSingleProject, true);
    assert.equal(config.profiles.master.allowedLinkKinds, '*');
  });

  it('refuses to enable vector search', (t) => {
    failure(() => loadRetrievalConfig(variant(t, (config) => void ((config.vector as { enabled: boolean }).enabled = true))), 'config-invalid', 'vector-not-implemented');
  });

  it('requires a weight for every kind', (t) => {
    failure(() => loadRetrievalConfig(variant(t, (config) => void delete (config.profiles.master.kindWeights as Record<string, number>).overview)), 'config-invalid');
  });

  it('requires every kind in exactly one section', (t) => {
    failure(() => loadRetrievalConfig(variant(t, (config) => void config.profiles.code.sections[0]!.kinds.shift())), 'config-invalid');
    failure(() => loadRetrievalConfig(variant(t, (config) => void config.profiles.code.sections[1]!.kinds.push('overview'))), 'config-invalid');
  });

  it('reserves the fixed section ids', (t) => {
    failure(() => loadRetrievalConfig(variant(t, (config) => void (config.profiles.master.sections[0]!.id = 'mandatory'))), 'config-invalid');
  });

  it('reports a missing file with reason not-found', (t) => {
    failure(() => loadRetrievalConfig(tempSpace(t).path('none.yaml')), 'config-invalid', 'not-found');
  });
});

describe('profile composition', () => {
  const FILES = {
    'a.md': doc('contract', '계약 자료'),
    'b.md': doc('business-rule', '업무 규칙 자료'),
    'c.md': doc('test-strategy', '검증 자료'),
    'd.md': doc('overview', '개요 자료'),
  };

  it('uses the master section order', (t) => {
    const response = search(built(t, [{ id: 'orders', files: FILES }]).context, master());
    assert.deepEqual(response.sections.map((section) => section.id), ['mandatory', 'dependencies', 'system', 'contracts', 'policies', 'cases', 'other']);
    assert.deepEqual(response.sections.find((section) => section.id === 'contracts')?.itemIds, ['orders:a.md#계약-자료']);
    assert.equal(response.items.find((item) => item.kind === 'contract')!.selection.section, 'contracts');
    assert.equal(response.sections[0]!.title, '필수 지정 자료(상태 확인 필요)');
    assert.equal(response.sections[1]!.title, '명시적 의존 관계');
  });

  it('uses the code section order and places api-catalog under structure', (t) => {
    const response = search(built(t, [{ id: 'orders', files: { ...FILES, 'e.md': doc('api-catalog', '카탈로그 자료') } }]).context, code());
    assert.deepEqual(response.sections.map((section) => section.id), ['mandatory', 'dependencies', 'structure', 'rules', 'verification', 'cases', 'contracts', 'other']);
    assert.ok(response.sections.find((section) => section.id === 'structure')!.itemIds.includes('orders:e.md#카탈로그-자료'));
  });

  it('orders the same corpus differently per profile', (t) => {
    const { context } = built(t, [{ id: 'orders', files: FILES }]);
    assert.equal(search(context, master()).items[0]!.kind, 'contract');
    assert.equal(search(context, code()).items[0]!.kind, 'business-rule');
  });

  it('applies the profile limit and the request limit', (t) => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`n${index}.md`, doc('reference', `자료 ${index}`)]));
    const { context } = built(t, [{ id: 'orders', files }]);
    assert.equal(search(context, master()).retrieval.directCount, 10);
    assert.equal(search(context, master()).request.limit, 10);
    assert.equal(search(context, master({ limit: 3 })).items.length, 3);
  });

  it('uses each profile excerpt size', (t) => {
    const { context } = built(t, [{ id: 'orders', files: { 'a.md': `# 제목\n\n${Array.from({ length: 200 }, (_, index) => `${WORD} 번호 ${index} 문장입니다.`).join('\n')}\n` } }]);
    assert.ok(search(context, master()).items[0]!.excerpt.length <= 900);
    const codeExcerpt = search(context, code()).items[0]!.excerpt.length;
    assert.ok(codeExcerpt > 900 && codeExcerpt <= 1200);
  });

  it('requires exactly one project for the code profile', (t) => {
    const { context } = built(t, [{ id: 'orders', files: FILES }, { id: 'billing', files: FILES }]);
    failure(() => search(context, code({ scope: { projects: ['orders', 'billing'] } })), 'invalid-scope', 'single-project-required');
    assert.equal(search(context, master({ scope: { projects: ['orders', 'billing'] } })).appliedScope.projects.length, 2);
  });

  it('does not let a profile widen the caller scope', (t) => {
    const { context } = built(t, [{ id: 'orders', files: FILES }, { id: 'billing', files: FILES }]);
    assert.ok(search(context, master()).items.every((item) => item.projectId === 'orders'));
  });
});

describe('mandatory and dependency lookup', () => {
  const FILES = {
    'must.md': '---\nkind: policy\nstatus: 확정\nmandatory: true\n---\n# 필수 정책\n\n반드시 지켜야 하는 내용이다.\n',
    'dep.md': '---\nkind: dependency\n---\n# 외부 의존\n\n외부 시스템을 호출한다.\n',
    'linked-dep.md': '# 의존 필드 자료\n\n- 의존: `DEP-X`\n\n다른 자료다.\n',
    'plain.md': '# 일반 자료\n\n관련 없는 내용이다.\n',
  };

  it('returns them without any text match and flags no-query-matches', (t) => {
    const response = search(built(t, [{ id: 'orders', files: FILES }]).context, master({ query: '전혀없는단어' }));
    assert.equal(response.status, 'ok');
    assert.equal(response.retrieval.directCount, 0);
    assert.deepEqual(response.sections[0]!.itemIds, ['orders:must.md#필수-정책']);
    assert.deepEqual(response.sections[1]!.itemIds, ['orders:dep.md#외부-의존', 'orders:linked-dep.md#의존-필드-자료']);
    assert.deepEqual(ids(response), [...response.sections[0]!.itemIds, ...response.sections[1]!.itemIds]);
    assert.deepEqual(limitation(response, 'no-query-matches'), {});
    assert.deepEqual(response.items.map((item) => item.selection.score), [0, 0, 0]);
    assert.deepEqual(response.items.map((item) => item.selection.rank), [1, 2, 3]);
    assert.equal(response.items[0]!.knowledge.confirmed, false);
  });

  it('shows an item once, mandatory winning over dependency and direct hits', (t) => {
    const { context } = built(t, [{ id: 'orders', files: { 'both.md': `---\nkind: dependency\nmandatory: true\n---\n# 둘 다\n\n${WORD} 본문이다.\n` } }]);
    const response = search(context, master());
    assert.deepEqual(ids(response), ['orders:both.md#둘-다']);
    assert.equal(response.items[0]!.selection.section, 'mandatory');
    assert.equal(response.retrieval.directCount, 0);
  });

  it('leaves deprecated and observed mandatory items out of the mandatory list', (t) => {
    const { context } = built(t, [
      {
        id: 'orders',
        files: {
          'gone.md': '---\nstatus: 폐기\nmandatory: true\n---\n# 폐기 필수\n\n폐기 내용이다.\n',
          'seen.md': '---\nstatus: 관찰\nmandatory: true\n---\n# 관찰 필수\n\n- 코드: `src/a.ts`\n\n관찰 내용이다.\n',
          'src/a.ts': 'x',
        },
      },
    ]);
    assert.deepEqual(search(context, master({ query: '전혀없는단어' })).sections[0]!.itemIds, []);
  });

  it('reports mandatory items removed by filters', (t) => {
    const response = search(built(t, [{ id: 'orders', files: FILES }]).context, master({ filters: { kinds: ['reference'] }, query: '일반' }));
    assert.deepEqual(response.sections[0]!.itemIds, []);
    assert.deepEqual(limitation(response, 'mandatory-filtered'), { count: 1 });
  });

  it('keeps every project represented when the mandatory cap applies', (t) => {
    const must = (index: number): string => `---\nmandatory: true\n---\n# 필수 ${index}\n\n내용이다.\n`;
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`m${index}.md`, must(index)]));
    const { context } = built(t, [{ id: 'aaa', files: many }, { id: 'bbb', files: { 'm.md': must(9) } }]);
    const response = search(withProfile(context, 'master', { mandatoryLimit: 2 }), master({ query: '전혀없는단어', scope: { projects: ['aaa', 'bbb'] } }));
    assert.deepEqual(ids(response), ['aaa:m0.md#필수-0', 'bbb:m.md#필수-9']);
    assert.deepEqual(limitation(response, 'mandatory-truncated'), { omittedIds: ['aaa:m1.md#필수-1', 'aaa:m2.md#필수-2', 'aaa:m3.md#필수-3', 'aaa:m4.md#필수-4'] });
  });

  it('applies the mandatory cap and truncation report to inherited mandatory items', (t) => {
    const { context } = built(t, [{ id: 'orders', files: { 'sec.md': '# 보안 정책\n\n- 구분: 필수\n\n## 암호화 규칙\n\n암호화 내용이다.\n\n## 접근 통제\n\n접근 내용이다.\n' } }]);
    const all = search(context, master({ query: '전혀없는단어' }));
    assert.deepEqual(ids(all), ['orders:sec.md#보안-정책', 'orders:sec.md#암호화-규칙', 'orders:sec.md#접근-통제']);
    assert.equal(limitation(all, 'mandatory-truncated'), undefined);
    const capped = search(withProfile(context, 'master', { mandatoryLimit: 1 }), master({ query: '전혀없는단어' }));
    assert.deepEqual(ids(capped), ['orders:sec.md#보안-정책']);
    assert.deepEqual(limitation(capped, 'mandatory-truncated'), { omittedIds: ['orders:sec.md#암호화-규칙', 'orders:sec.md#접근-통제'] });
  });

  it('caps dependencies and reports the omitted ids', (t) => {
    const many = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`d${index}.md`, `---\nkind: dependency\n---\n# 의존 ${index}\n\n내용이다.\n`]));
    const { context } = built(t, [{ id: 'orders', files: many }]);
    const response = search(withProfile(context, 'master', { dependencyLimit: 1 }), master({ query: '전혀없는단어' }));
    assert.deepEqual(ids(response), ['orders:d0.md#의존-0']);
    assert.deepEqual(limitation(response, 'dependencies-truncated'), { omittedIds: ['orders:d1.md#의존-1', 'orders:d2.md#의존-2'] });
  });

  it('shares the dependency cap across projects', (t) => {
    const many = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`d${index}.md`, `---\nkind: dependency\n---\n# 의존 ${index}\n\n내용이다.\n`]));
    const one = { 'z.md': '---\nkind: dependency\n---\n# 작은 의존\n\n내용이다.\n' };
    const { context } = built(t, [{ id: 'big', files: many }, { id: 'small', files: one }]);
    const response = search(withProfile(context, 'master', { dependencyLimit: 2 }), master({ query: '전혀없는단어', scope: { projects: ['big', 'small'] } }));
    assert.deepEqual(ids(response), ['big:d0.md#의존-0', 'small:z.md#작은-의존']);
    assert.deepEqual(limitation(response, 'dependencies-truncated'), { omittedIds: ['big:d1.md#의존-1', 'big:d2.md#의존-2'] });
  });

  it('looks up dependencies only in primary projects', (t) => {
    const { context } = built(t, [{ id: 'orders', files: { 'p.md': '# 일반\n\n내용이다.\n' } }, { id: 'billing', files: FILES }]);
    const response = search(context, master({ query: '전혀없는단어', scope: { projects: ['orders'], allowedLinks: [{ project: 'billing' }] } }));
    assert.deepEqual(ids(response), []);
  });
});

describe('link expansion', () => {
  const ORDERS = {
    'a.md': `# 시작 자료\n\n- 정책: \`POL-1\`\n\n${WORD} 시작점이다.\n`,
    'b.md': '### `POL-1` 첫 정책\n\n- 연결: `POL-2`\n\n정책 내용이다.\n',
    'c.md': '### `POL-2` 둘째 정책\n\n- 연결: `POL-3`\n\n정책 내용이다.\n',
    'd.md': '### `POL-3` 셋째 정책\n\n정책 내용이다.\n',
  };

  it('follows links up to the profile depth', (t) => {
    const { context } = built(t, [{ id: 'orders', files: ORDERS }]);
    const deep = search(context, master());
    assert.deepEqual(ids(deep), ['orders:a.md#시작-자료', 'orders:b.md#POL-1', 'orders:c.md#POL-2']);
    assert.deepEqual(deep.items[1]!.selection.reasons, ['linked:policy:orders:a.md#시작-자료']);
    assert.equal(deep.items[1]!.selection.score, 0);
    assert.equal(deep.items[0]!.links[0]!.included, true);
    assert.equal(deep.items[0]!.links[0]!.targetItemId, 'orders:b.md#POL-1');
    assert.deepEqual(ids(search(context, code())), ['orders:a.md#시작-자료', 'orders:b.md#POL-1']);
  });

  it('does not traverse through rejected items', (t) => {
    const { context } = built(t, [{ id: 'orders', files: { ...ORDERS, 'b.md': '---\nstatus: 폐기\n---\n### `POL-1` 첫 정책\n\n- 연결: `POL-2`\n\n정책 내용이다.\n' } }]);
    const response = search(context, master());
    assert.deepEqual(ids(response), ['orders:a.md#시작-자료']);
    assert.equal(response.items[0]!.links[0]!.inScope, true);
    assert.equal(response.items[0]!.links[0]!.included, false);
  });

  it('caps linked items and reports the rest', (t) => {
    const { context } = built(t, [{ id: 'orders', files: { ...ORDERS, 'a.md': `# 시작 자료\n\n- 정책: \`POL-1\` \`POL-2\` \`POL-3\`\n\n${WORD} 시작점이다.\n` } }]);
    const response = search(withProfile(context, 'master', { linkLimit: 1 }), master());
    assert.deepEqual(ids(response), ['orders:a.md#시작-자료', 'orders:b.md#POL-1']);
    assert.deepEqual(limitation(response, 'links-truncated'), { omittedIds: ['orders:c.md#POL-2', 'orders:d.md#POL-3'] });
  });

  it('crosses projects only into allowed scope', (t) => {
    const sources: FixtureSource[] = [
      { id: 'orders', files: { 'a.md': `# 시작 자료\n\n- 계약: \`billing:CON-1\`\n\n${WORD} 시작점이다.\n` } },
      { id: 'billing', files: { 'c.md': '---\nkind: contract\n---\n### `CON-1` 정산 계약\n\n계약 내용이다.\n' } },
    ];
    const { context } = built(t, sources);
    const blocked = search(context, master());
    assert.deepEqual(ids(blocked), ['orders:a.md#시작-자료']);
    assert.deepEqual(blocked.items[0]!.links, [{ relation: 'contract', target: 'billing:CON-1', resolved: true, included: false, inScope: false }]);
    assert.deepEqual(limitation(blocked, 'out-of-scope-links'), { count: 1, targets: ['billing:CON-1'] });

    const allowed = search(context, master({ scope: { projects: ['orders'], allowedLinks: [{ project: 'billing' }] } }));
    assert.deepEqual(ids(allowed), ['orders:a.md#시작-자료', 'billing:c.md#CON-1']);
    assert.equal(allowed.items[0]!.links[0]!.inScope, true);
    assert.equal(allowed.items[0]!.links[0]!.included, true);
    assert.equal(allowed.items[0]!.links[0]!.targetProject, 'billing');
    assert.equal(limitation(allowed, 'out-of-scope-links'), undefined);
  });

  it('reports unresolved and ambiguous links without listing candidates', (t) => {
    const { context } = built(t, [
      {
        id: 'orders',
        files: {
          'a.md': `# 시작 자료\n\n- 정책: \`POL-404\` \`POL-DUP\`\n\n${WORD} 시작점이다.\n`,
          'b.md': '### `POL-DUP` 하나\n\n내용이다.\n',
          'c.md': '### `POL-DUP` 둘\n\n내용이다.\n',
        },
      },
    ]);
    const response = search(context, master());
    assert.deepEqual(response.items[0]!.links, [
      { relation: 'policy', target: 'POL-404', resolved: false, included: false, inScope: false },
      { relation: 'policy', target: 'POL-DUP', resolved: false, ambiguous: true, included: false, inScope: false },
    ]);
    assert.deepEqual(limitation(response, 'unresolved-links'), { count: 2, targets: ['POL-404', 'POL-DUP'] });
    assert.ok(!JSON.stringify(response.items[0]!.links).includes('b.md'));
  });
});

describe('code locations', () => {
  const FILES = {
    'a.md': `# 구현 자료\n\n- 코드: \`src/a.ts\`, src/none.ts\n- 테스트: \`tests/a.test.ts\`\n\n${WORD} 본문이다.\n`,
    'b.md': `# 또 다른 자료\n\n- 코드: \`src/a.ts\`\n\n${WORD} 본문이다.\n`,
    'src/a.ts': 'export {};\n',
    'tests/a.test.ts': 'export {};\n',
  };

  it('aggregates by source, path and relation for the code profile', (t) => {
    const fixture = built(t, [{ id: 'orders', files: FILES }]);
    const sha = git(fixture.repo('orders'), ['rev-parse', 'HEAD']);
    const response = search(fixture.context, code());
    assert.deepEqual(response.codeLocations, [
      { sourceId: 'orders', projectId: 'orders', commit: sha, path: 'src/a.ts', relation: 'code', resolved: true, fromItemIds: ['orders:a.md#구현-자료', 'orders:b.md#또-다른-자료'] },
      { sourceId: 'orders', projectId: 'orders', commit: sha, path: 'src/none.ts', relation: 'code', resolved: false, fromItemIds: ['orders:a.md#구현-자료'] },
      { sourceId: 'orders', projectId: 'orders', commit: sha, path: 'tests/a.test.ts', relation: 'test', resolved: true, fromItemIds: ['orders:a.md#구현-자료'] },
    ]);
  });

  it('is empty for the master profile', (t) => {
    assert.deepEqual(search(built(t, [{ id: 'orders', files: FILES }]).context, master()).codeLocations, []);
  });

  it('comes only from included items', (t) => {
    const response = search(built(t, [{ id: 'orders', files: FILES }]).context, code({ limit: 1 }));
    assert.equal(response.items.length, 1);
    const included = new Set(response.items.map((item) => item.id));
    for (const location of response.codeLocations) assert.ok(location.fromItemIds.every((id) => included.has(id)));
  });
});

describe('out-of-scope safety', () => {
  // visible은 범위 안, vault는 연결을 선언한 대상, hidden-proj는 선언 없이 계약 키만 겹치는 프로젝트다.
  const SOURCES: FixtureSource[] = [
    {
      id: 'visible-src',
      project: 'visible',
      files: {
        'docs/start.md': [
          '---',
          'kind: contract',
          'status: 확정',
          'status_basis: item:vault:POL-1',
          'relations:',
          '  contract: [vault:CON-9, vault:CON-DUP]',
          '  dependency: [vault:CON-9]',
          '---',
          '### `CON-SHARED` 공개 계약',
          '',
          `${WORD} 공개 계약 본문이다.`,
          '',
        ].join('\n'),
      },
    },
    {
      id: 'vault-repo',
      project: 'vault',
      files: {
        'docs/vault-contract.md': '---\nkind: contract\n---\n### `CON-9` 금고 계약\n\n금고전용문구 본문이다.\n',
        'docs/vault-dup-a.md': '---\nkind: contract\n---\n### `CON-DUP` 금고 중복\n\n금고전용문구 본문이다.\n',
        'docs/vault-dup-b.md': '---\nkind: contract\n---\n### `CON-DUP` 금고 중복\n\n금고전용문구 본문이다.\n',
        'docs/vault-policy.md': '---\nkind: policy\nstatus: 확정\nstatus_basis: docs/vault-contract.md\n---\n### `POL-1` 금고 정책\n\n금고전용문구 본문이다.\n',
        'docs/vault-broken.md': Buffer.from([0xff, 0xfe]),
      },
    },
    {
      id: 'hidden-repo',
      project: 'hidden-proj',
      files: {
        'docs/hidden-contract.md': '---\nkind: contract\n---\n### `CON-SHARED` 숨은 계약\n\n숨김전용문구 본문이다.\n',
        'docs/hidden-broken.md': Buffer.from([0xff, 0xfe]),
      },
    },
  ];

  const PATHS = ['docs/vault-contract.md', 'docs/vault-dup-a.md', 'docs/vault-dup-b.md', 'docs/vault-policy.md', 'docs/vault-broken.md', 'docs/hidden-contract.md', 'docs/hidden-broken.md'];
  const ITEM_IDS = ['vault-repo:docs/vault-contract.md#CON-9', 'hidden-repo:docs/hidden-contract.md#CON-SHARED'];
  const SOURCE_IDS = ['vault-repo', 'hidden-repo'];
  const BODIES = ['금고전용문구', '숨김전용문구', '금고 계약', '금고 정책', '숨은 계약'];

  /** 작성자가 범위 안 문서에 직접 적은 target 문자열만 프로젝트 ID를 담을 수 있다. 나머지 출력에는 어떤 흔적도 없어야 한다. */
  function withoutDeclaredTargets(response: SearchResponse): string {
    const copy = structuredClone(response);
    for (const item of copy.items) {
      for (const link of item.links) if (!link.inScope) link.target = '';
      for (const conflict of item.knowledge.conflicts) delete conflict.target;
    }
    for (const entry of copy.limitations) {
      if (entry.code === 'out-of-scope-links' || entry.code === 'unresolved-links') entry.detail.targets = [];
    }
    return JSON.stringify(copy);
  }

  function assertClean(response: SearchResponse): void {
    const json = JSON.stringify(response);
    for (const needle of [...SOURCE_IDS, ...PATHS, ...ITEM_IDS, ...BODIES, 'hidden-proj']) assert.ok(!json.includes(needle), `leaked ${needle}`);
    assert.ok(!withoutDeclaredTargets(response).includes('vault'), 'leaked vault outside declared targets');
  }

  it('leaves no trace of out-of-scope projects in master output', (t) => {
    const response = search(built(t, SOURCES).context, { profile: 'master', query: WORD, scope: { projects: ['visible'] } });
    assert.equal(response.items.length, 1);
    assertClean(response);
    assert.deepEqual(limitation(response, 'out-of-scope-links'), { count: 2, targets: ['vault:CON-9'] });
    assert.deepEqual(limitation(response, 'unresolved-links'), { count: 1, targets: ['vault:CON-DUP'] });
  });

  it('leaves no trace of out-of-scope projects in code output', (t) => {
    assertClean(search(built(t, SOURCES).context, { profile: 'code', query: WORD, scope: { projects: ['visible'] } }));
  });

  it('leaves no trace when the query targets out-of-scope text', (t) => {
    const response = search(built(t, SOURCES).context, { profile: 'master', query: '금고전용문구 숨김전용문구 CON-9', scope: { projects: ['visible'] } });
    // request.query는 호출자가 보낸 문자열을 되돌려 주는 것이므로 검사 대상이 아니다
    assertClean({ ...response, request: { ...response.request, query: null } });
    assert.equal(response.status, 'ok');
    assert.equal(response.retrieval.directCount, 0);
  });

  it('leaves no trace in get output', (t) => {
    const { context } = built(t, SOURCES);
    const response = getItem(context, { id: 'visible-src:docs/start.md#CON-SHARED', profile: 'master', scope: { projects: ['visible'] } });
    const json = JSON.stringify(response);
    for (const needle of [...SOURCE_IDS, ...PATHS, ...ITEM_IDS, ...BODIES, 'hidden-proj']) assert.ok(!json.includes(needle), `leaked ${needle}`);
  });

  it('keeps the conflict and basis facts while removing out-of-scope ids', (t) => {
    const item = search(built(t, SOURCES).context, { profile: 'master', query: WORD, scope: { projects: ['visible'] } }).items[0]!;
    assert.equal(item.knowledge.status, 'conflicted');
    assert.equal(item.knowledge.baseStatus, 'confirmed_policy');
    assert.equal(item.knowledge.confirmed, false);
    assert.deepEqual(item.knowledge.conflicts, [{ reason: 'duplicate-contract-owner', withItemIds: [], outOfScopeCount: 1 }]);
    assert.deepEqual(item.knowledge.basis.refs, []);
    assert.equal(item.knowledge.basis.outOfScopeCount, 1);
  });

  it('keeps in-scope ids when the other side of a conflict is allowed', (t) => {
    const item = search(built(t, SOURCES).context, { profile: 'master', query: WORD, scope: { projects: ['visible'], allowedLinks: [{ project: 'hidden-proj' }] } }).items.find((candidate) => candidate.projectId === 'visible')!;
    assert.deepEqual(item.knowledge.conflicts, [{ reason: 'duplicate-contract-owner', withItemIds: ['hidden-repo:docs/hidden-contract.md#CON-SHARED'], outOfScopeCount: 0 }]);
  });

  it('counts but never lists allowed-link skipped documents', (t) => {
    const response = search(built(t, SOURCES).context, { profile: 'master', query: WORD, scope: { projects: ['visible'], allowedLinks: [{ project: 'hidden-proj' }] } });
    assert.deepEqual(limitation(response, 'skipped-documents'), { count: 1, byReason: { 'not-utf8': 1 }, paths: [] });
    assert.ok(!JSON.stringify(response).includes('docs/hidden-broken.md'));
  });

  it('keeps index sources to the requested projects', (t) => {
    const response = search(built(t, SOURCES).context, { profile: 'master', query: WORD, scope: { projects: ['visible'] } });
    assert.deepEqual(response.index.sources.map((source) => source.sourceId), ['visible-src']);
  });

  it('reads items only through the shared scope module', () => {
    const directory = fileURLToPath(new URL('../src/retrieval/', import.meta.url));
    const compiled = readdirSync(directory).filter((name) => name.endsWith('.js'));
    assert.ok(compiled.includes('scope.js'));
    assert.deepEqual(compiled.filter((name) => name !== 'scope.js' && /\bgeneration_items\b|\b(?:FROM|JOIN) (?:items|documents)\b/.test(readFileSync(join(directory, name), 'utf8'))), []);
  });

  it('covers every kind in both profiles', () => {
    const config = loadRetrievalConfig(RETRIEVAL_CONFIG_PATH);
    for (const profile of [config.profiles.master, config.profiles.code]) {
      assert.deepEqual(profile.sections.flatMap((section) => section.kinds).sort(), [...KINDS].sort());
    }
  });
});
