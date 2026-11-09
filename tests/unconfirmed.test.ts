import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { EFFECTIVE_STATUSES, getItem, search, type OutputItem, type SearchResponse } from '../src/index.js';
import { knowledgeFixture, type KnowledgeFixture } from './helpers.js';

const WORD = '공통단어';
const entry = (key: string, fields: string[]): string => [`### \`${key}\` ${key} 항목`, ...fields.map((field) => `- ${field}`), '', `${WORD} 본문이다.`, ''].join('\n');

const FILES = {
  'docs/evidence.md': '# 근거 자료\n\n실제로 존재하는 근거 문서다.\n',
  'src/a.ts': 'export const a = 1;\n',
  'docs/items.md': [
    '# 항목',
    '',
    entry('OK-1', ['상태: 확정', '근거: docs/evidence.md']),
    entry('OK-2', ['상태: 검증됨', '근거: docs/evidence.md']),
    entry('NO-BASIS', ['상태: 확정']),
    entry('NO-BASIS-V', ['상태: 검증됨']),
    entry('BAD-BASIS', ['상태: 확정', '근거: docs/none.md']),
    entry('PENDING', ['상태: 확정 예정', '근거: docs/evidence.md']),
    entry('UNVERIFIED', ['상태: 미확인', '근거: docs/evidence.md']),
    entry('OBSERVED', ['상태: 관찰', '코드: src/a.ts']),
    entry('OBSERVED-NONE', ['상태: 관찰']),
    entry('GONE', ['상태: 폐기', '근거: docs/evidence.md']),
    entry('DUP', ['상태: 확정', '근거: docs/evidence.md']),
    entry('DUP', ['상태: 확정', '근거: docs/evidence.md']),
    entry('CLASH-A', ['상태: 확정', '근거: docs/evidence.md', '충돌: `CLASH-B`']),
    entry('CLASH-B', ['상태: 확정', '근거: docs/evidence.md']),
    entry('PLAIN', []),
  ].join('\n'),
};

function corpus(t: TestContext): KnowledgeFixture {
  const fixture = knowledgeFixture(t, [{ id: 'orders', files: FILES }]);
  fixture.index();
  return fixture;
}

function everything(fixture: KnowledgeFixture): SearchResponse {
  return search(fixture.context, { profile: 'master', query: WORD, scope: { projects: ['orders'] }, filters: { statuses: [...EFFECTIVE_STATUSES] }, limit: 50 });
}

const byKey = (response: SearchResponse, key: string): OutputItem[] => response.items.filter((item) => item.key === key);
const single = (response: SearchResponse, key: string): OutputItem => {
  const [item, ...rest] = byKey(response, key);
  assert.ok(item, key);
  assert.equal(rest.length, 0, key);
  return item;
};

describe('confirmed flag', () => {
  it('is true only for resolved confirmed or verified items', (t) => {
    const response = everything(corpus(t));
    assert.deepEqual(single(response, 'OK-1').knowledge.confirmed, true);
    assert.equal(single(response, 'OK-1').knowledge.status, 'confirmed_policy');
    assert.equal(single(response, 'OK-2').knowledge.confirmed, true);
    assert.equal(single(response, 'OK-2').knowledge.status, 'verified_experience');
    const confirmedKeys = response.items.filter((item) => item.knowledge.confirmed).map((item) => item.key).sort();
    assert.deepEqual(confirmedKeys, ['OK-1', 'OK-2']);
  });

  const cases: [string, string, string][] = [
    ['NO-BASIS', 'unverified', 'status-basis-missing'],
    ['NO-BASIS-V', 'unverified', 'status-basis-missing'],
    ['BAD-BASIS', 'unverified', 'status-basis-unresolved'],
    ['PENDING', 'unverified', 'unknown-status-value'],
    ['UNVERIFIED', 'unverified', 'declared'],
    ['OBSERVED', 'observed_behavior', 'code-reference-resolved'],
    ['OBSERVED-NONE', 'unverified', 'observation-without-code-reference'],
    ['GONE', 'deprecated', 'declared-deprecated'],
    ['PLAIN', 'unverified', 'status-not-declared'],
  ];
  for (const [key, status, reason] of cases) {
    it(`never marks ${key} as confirmed`, (t) => {
      const { knowledge } = single(everything(corpus(t)), key);
      assert.equal(knowledge.status, status);
      assert.equal(knowledge.reason, reason);
      assert.equal(knowledge.confirmed, false);
    });
  }

  it('does not treat a conflicted item as confirmed even though its base status is', (t) => {
    const response = everything(corpus(t));
    for (const key of ['CLASH-A', 'CLASH-B']) {
      const { knowledge } = single(response, key);
      assert.equal(knowledge.status, 'conflicted');
      assert.equal(knowledge.statusLabel, '충돌');
      assert.equal(knowledge.baseStatus, 'confirmed_policy');
      assert.equal(knowledge.confirmed, false);
      assert.equal(knowledge.conflicts[0]!.reason, 'declared');
    }
    const duplicates = byKey(response, 'DUP');
    assert.equal(duplicates.length, 2);
    for (const { knowledge } of duplicates) {
      assert.equal(knowledge.status, 'conflicted');
      assert.equal(knowledge.confirmed, false);
      assert.equal(knowledge.conflicts[0]!.reason, 'duplicate-key');
    }
  });

  it('labels what the status means rather than echoing a confirmed claim', (t) => {
    const { knowledge } = single(everything(corpus(t)), 'NO-BASIS');
    assert.equal(knowledge.declaredStatus, 'confirmed_policy');
    assert.equal(knowledge.statusLabel, '미확인 자료');
  });

  it('counts unconfirmed results in limitations', (t) => {
    const response = everything(corpus(t));
    const expected = response.items.filter((item) => !item.knowledge.confirmed).length;
    assert.ok(expected > 0);
    assert.deepEqual(response.limitations.find((limitation) => limitation.code === 'unconfirmed-results')?.detail, { count: expected });
  });

  it('keeps get consistent with search', (t) => {
    const fixture = corpus(t);
    const response = everything(fixture);
    for (const item of response.items) {
      const fetched = getItem(fixture.context, { id: item.id, profile: 'master', scope: { projects: ['orders'] } });
      assert.equal(fetched.item.knowledge.confirmed, item.knowledge.confirmed, item.id);
      assert.equal(fetched.item.knowledge.status, item.knowledge.status, item.id);
    }
  });
});

describe('source rules', () => {
  it('confirms from an operator basis but cannot lift an item the author marked lower', (t) => {
    const fixture = knowledgeFixture(t, [
      {
        id: 'orders',
        files: {
          'a.md': `# 규칙 문서\n\n${WORD} 운영자 근거 문서다.\n`,
          'b.md': `# 미확인 문서\n\n- 상태: 미확인\n\n${WORD} 낮춰 표시한 문서다.\n`,
        },
        extra: { rules: [{ match: '*.md', status: 'confirmed_policy', basis: '운영자 승인 기록' }] },
      },
    ]);
    fixture.index();
    const response = everything(fixture);
    const ruled = response.items.find((item) => item.id === 'orders:a.md#규칙-문서')!;
    assert.equal(ruled.knowledge.confirmed, true);
    assert.equal(ruled.knowledge.reason, 'source-rule');
    assert.deepEqual(ruled.knowledge.basis, { kind: 'source-rule', value: '운영자 승인 기록', rule: '*.md', resolution: 'operator-declared' });
    const lowered = response.items.find((item) => item.id === 'orders:b.md#미확인-문서')!;
    assert.equal(lowered.knowledge.confirmed, false);
    assert.equal(lowered.knowledge.reason, 'declared-overrides-source-rule');
  });

  it('does not confirm an item whose author wrote a status outside the vocabulary', (t) => {
    const fixture = knowledgeFixture(t, [
      {
        id: 'orders',
        files: { 'a.md': `# 문서\n\n${entry('DRAFT', ['상태: 초안'])}` },
        extra: { rules: [{ match: '*.md', status: 'confirmed_policy', basis: '운영자 승인 기록' }] },
      },
    ]);
    fixture.index();
    const { knowledge } = single(everything(fixture), 'DRAFT');
    assert.equal(knowledge.status, 'unverified');
    assert.equal(knowledge.reason, 'unknown-status-value');
    assert.equal(knowledge.confirmed, false);
  });
});

describe('status settled across items', () => {
  const STATED = ['상태: 확정', '근거: docs/evidence.md'];
  const fixtureOf = (t: TestContext, files: Record<string, string>): KnowledgeFixture => {
    const fixture = knowledgeFixture(t, [{ id: 'orders', files: { 'docs/evidence.md': '# 근거 자료\n\n존재하는 근거 문서다.\n', ...files } }]);
    fixture.index();
    return fixture;
  };

  it('does not confirm an item whose only basis is in conflict', (t) => {
    const response = everything(fixtureOf(t, {
      'docs/a.md': `# 가\n\n${entry('ON-CONFLICT', ['상태: 확정', '근거: item:TARGET'])}`,
      'docs/b.md': `# 나\n\n${entry('TARGET', [...STATED, '충돌: 정산 정책과 어긋남'])}`,
    }));
    assert.equal(single(response, 'TARGET').knowledge.status, 'conflicted');
    const { knowledge } = single(response, 'ON-CONFLICT');
    assert.equal(knowledge.status, 'unverified');
    assert.equal(knowledge.reason, 'status-basis-unresolved');
    assert.equal(knowledge.confirmed, false);
  });

  it('does not confirm an item whose basis document is withdrawn', (t) => {
    const { knowledge } = single(everything(fixtureOf(t, {
      'docs/old.md': '---\nstatus: 폐기\n---\n# 낡은 결정\n\n더 이상 쓰지 않는 결정이다.\n',
      'docs/a.md': `# 가\n\n${entry('ON-OLD', ['상태: 확정', '근거: docs/old.md'])}`,
    })), 'ON-OLD');
    assert.equal(knowledge.status, 'unverified');
    assert.equal(knowledge.confirmed, false);
  });

  it('retires a replaced item from default results and names the replacement', (t) => {
    const fixture = fixtureOf(t, {
      'docs/a.md': `# 가\n\n${entry('OLD', STATED)}`,
      'docs/b.md': `# 나\n\n${entry('NEW', [...STATED, '대체: `OLD`'])}`,
    });
    const newId = 'orders:docs/b.md#NEW';
    const { knowledge } = single(everything(fixture), 'OLD');
    assert.equal(knowledge.status, 'deprecated');
    assert.equal(knowledge.reason, 'superseded');
    assert.equal(knowledge.confirmed, false);
    assert.deepEqual(knowledge.basis, { kind: 'refs', resolution: 'resolved', refs: [{ kind: 'item', value: newId, resolved: true, targetItemId: newId }], outOfScopeCount: 0 });
    const defaults = search(fixture.context, { profile: 'master', query: WORD, scope: { projects: ['orders'] }, limit: 50 });
    assert.deepEqual(defaults.items.map((item) => item.key), ['NEW']);
  });

  it('shows a confirmed item replaced by an unconfirmed one as a conflict', (t) => {
    const response = everything(fixtureOf(t, {
      'docs/a.md': `# 가\n\n${entry('OLD', STATED)}`,
      'docs/b.md': `# 나\n\n${entry('NEW', ['상태: 미확인', '대체: `OLD`'])}`,
    }));
    const { knowledge } = single(response, 'OLD');
    assert.equal(knowledge.status, 'conflicted');
    assert.equal(knowledge.statusLabel, '충돌');
    assert.equal(knowledge.baseStatus, 'confirmed_policy');
    assert.equal(knowledge.confirmed, false);
    assert.deepEqual(knowledge.conflicts, [{ reason: 'unconfirmed-supersession', withItemIds: ['orders:docs/b.md#NEW'], outOfScopeCount: 0 }]);
    assert.ok((response.limitations.find((limitation) => limitation.code === 'unconfirmed-results')?.detail.count as number) > 0);
  });

  for (const [name, replacement, status] of [
    ['conflict', '미확인', 'conflicted'],
    ['replacement', '확정', 'deprecated'],
  ] as const) {
    it(`does not name a replacing item outside the search scope in a ${name}`, (t) => {
      const fixture = knowledgeFixture(t, [
        { id: 'orders', files: { 'docs/evidence.md': '# 근거\n\n근거 문서다.\n', 'docs/a.md': `# 가\n\n${entry('OLD', STATED)}`, 'docs/b.md': `# 나\n\n${entry('NEW', [`상태: ${replacement}`, '근거: docs/evidence.md', '대체: `OLD`'])}` } },
        { id: 'other', files: { 'docs/o.md': '# 다른 문서\n\n내용이다.\n' } },
      ]);
      fixture.index();
      const scope = { projects: ['other'], allowedLinks: [{ project: 'orders', kinds: ['reference' as const], itemIds: ['orders:docs/a.md#OLD'] }] };
      const response = search(fixture.context, { profile: 'master', query: WORD, scope, filters: { statuses: [...EFFECTIVE_STATUSES] }, limit: 50 });
      const { knowledge } = single(response, 'OLD');
      assert.equal(knowledge.status, status);
      assert.equal(knowledge.confirmed, false);
      if (status === 'conflicted') assert.deepEqual(knowledge.conflicts, [{ reason: 'unconfirmed-supersession', withItemIds: [], outOfScopeCount: 1 }]);
      else assert.deepEqual([knowledge.reason, knowledge.basis.refs, knowledge.basis.outOfScopeCount], ['superseded', [], 1]);
      assert.equal(JSON.stringify(response).includes('docs/b.md'), false);
    });
  }
});
