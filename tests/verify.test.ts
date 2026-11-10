import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { after, describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acquireLease,
  EFFECTIVE_STATUSES,
  EXIT_CODES,
  getItem,
  getItemV2,
  KnowledgeError,
  MAX_REFERENCES,
  openForWrite,
  searchV2,
  verifyReferences,
  type EffectiveStatus,
  type ErrorCode,
  type GetResponseV2,
  type ItemRef,
  type RetrievalContext,
  type VerifyResponse,
  type VerifyResult,
} from '../src/index.js';
import { refHandle } from '../src/retrieval/compose-v2.js';
import { compareStrings } from '../src/util/compare.js';
import { commit, git, knowledgeFixture, tempSpace, type FixtureSource, type KnowledgeFixture } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli/main.js', import.meta.url));

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const sorted = (values: readonly string[]): string[] => [...values].sort(compareStrings);

/** 한 문단이 한도의 절반을 넘으므로 두 문단이 한 조각에 들어가지 않는다. */
const paragraph = (word: string, ordinal: string): string => `${word} 문장은 조각 경계를 시험하는 ${ordinal} 문단이다. `.repeat(35).trim();
const ALPHA = paragraph('알파', '첫째');
const BETA = paragraph('베타', '둘째');
const GAMMA = paragraph('감마', '셋째');
/** 조각은 제목과 첫 문단(1~3행), 둘째 문단(5행) 둘이다. */
const LONG = `# 긴 문서\n\n${ALPHA}\n\n${BETA}\n`;

const A_BEFORE = [
  '# 배송 안내',
  '',
  '배송 안내 본문이다.',
  '',
  '## 그대로 절',
  '',
  '배송 그대로 본문이다.',
  '',
  '## 변경 절',
  '',
  '배송 변경 전 본문이다.',
  '',
  '## 이동 절',
  '',
  '배송 이동 본문이다.',
  '',
  '## 삭제 절',
  '',
  '배송 삭제 본문이다.',
  '',
].join('\n');

const A_AFTER = ['# 배송 안내', '', '배송 안내 본문이다.', '', '## 그대로 절', '', '배송 그대로 본문이다.', '', '## 변경 절', '', '배송 변경 후 본문이다.', ''].join('\n');
const B_AFTER = '# 새 문서\n\n새 문서 본문이다.\n\n## 이동 절\n\n배송 이동 본문이다.\n';

const ORDERS = {
  'docs/evidence.md': '# 근거 자료\n\n배송 근거 문서다.\n',
  'docs/a.md': A_BEFORE,
  'docs/long.md': LONG,
};

const BILLING_LONG = `# 정산 긴 문서\n\n${paragraph('정산', '첫째')}\n\n${paragraph('환불', '둘째')}\n`;
const BILLING = {
  'docs/contract.md': '---\nkind: contract\n---\n# 정산 계약\n\n정산 비밀 계약 본문이다.\n',
  'docs/other.md': '---\nkind: contract\n---\n# 환불 계약\n\n환불 계약 본문이다.\n',
  'docs/long.md': BILLING_LONG,
};

const ID = {
  intro: 'orders:docs/a.md#배송-안내',
  same: 'orders:docs/a.md#그대로-절',
  changed: 'orders:docs/a.md#변경-절',
  moved: 'orders:docs/a.md#이동-절',
  movedTo: 'orders:docs/b.md#이동-절',
  removed: 'orders:docs/a.md#삭제-절',
  long: 'orders:docs/long.md#긴-문서',
  contract: 'billing:docs/contract.md#정산-계약',
  otherContract: 'billing:docs/other.md#환불-계약',
  billingLong: 'billing:docs/long.md#정산-긴-문서',
};

const ORDERS_SCOPE = { projects: ['orders'] };
const NEVER_CONFIRMED: readonly EffectiveStatus[] = ['unverified', 'deprecated', 'conflicted', 'observed_behavior'];

function corpus(t: TestContext, retainGenerations = 5): KnowledgeFixture {
  const fixture = knowledgeFixture(t, [{ id: 'orders', files: ORDERS }, { id: 'billing', files: BILLING }], retainGenerations);
  fixture.index();
  return fixture;
}

const sharedCleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of sharedCleanups.splice(0)) cleanup();
});
let sharedCorpus: KnowledgeFixture | undefined;

/** 저장소와 색인을 바꾸지 않는 시험은 색인 하나를 함께 쓴다. 시간 대부분이 git 호출과 색인에 든다. */
function shared(): KnowledgeFixture {
  sharedCorpus ??= corpus({ after: (cleanup: () => void) => void sharedCleanups.push(cleanup) } as unknown as TestContext);
  return sharedCorpus;
}

function small(t: TestContext, sources: FixtureSource[]): KnowledgeFixture {
  const fixture = knowledgeFixture(t, sources);
  fixture.index();
  return fixture;
}

function lookup(context: RetrievalContext, id: string, extra: Record<string, unknown> = {}): GetResponseV2 {
  return getItemV2(context, { responseVersion: 2, id, profile: 'master', scope: ORDERS_SCOPE, ...extra });
}

const refOf = (context: RetrievalContext, id: string, extra: Record<string, unknown> = {}): ItemRef => lookup(context, id, extra).item.ref;

function verify(context: RetrievalContext, references: readonly unknown[], extra: Record<string, unknown> = {}): VerifyResponse {
  return verifyReferences(context, { profile: 'master', scope: ORDERS_SCOPE, references, ...extra });
}

const only = (response: VerifyResponse): VerifyResult => {
  assert.equal(response.results.length, 1);
  return response.results[0]!;
};

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

const reasonOf = (error: KnowledgeError): unknown => (error.detail as { reason?: unknown } | undefined)?.reason;

const segmentId = (itemId: string, ordinal: number): string => `${itemId}#${ordinal}`;

describe('reference handles', () => {
  it('gives every search ref an ak- handle of 20 hex that its fields reproduce', () => {
    const fixture = shared();
    const request = { responseVersion: 2 as const, profile: 'master' as const, query: '배송', scope: ORDERS_SCOPE };
    const first = searchV2(fixture.context, request);
    assert.ok(first.items.length >= 4, JSON.stringify(first.items.map((item) => item.id)));
    for (const item of first.items) {
      const { ref } = item;
      assert.match(ref.handle, /^ak-[0-9a-f]{20}$/);
      assert.equal(refHandle(ref), ref.handle);
      assert.equal(ref.itemId, item.id);
      assert.equal(ref.itemSha256, item.provenance.itemSha256);
      assert.equal(ref.documentSha256, item.provenance.documentSha256);
      assert.equal(ref.blobSha, item.provenance.blobSha);
      assert.equal(ref.commit, item.provenance.commit);
      assert.equal(ref.path, item.provenance.path);
      assert.deepEqual([ref.startLine, ref.endLine], [item.provenance.startLine, item.provenance.endLine]);
      assert.deepEqual([ref.sourceId, ref.projectId], [item.sourceId, item.projectId]);
      assert.equal(ref.indexGeneration, 1);
      assert.equal(ref.indexId, first.index.indexId);
      assert.match(ref.indexId!, /^[0-9a-f]{32}$/);
      assert.deepEqual([ref.segmentId, ref.segmentSha256, ref.segmentStartLine, ref.segmentEndLine], [null, null, null, null]);
    }
    assert.equal(new Set(first.items.map((item) => item.ref.handle)).size, first.items.length);
    assert.equal(first.items.find((item) => item.id === ID.same)!.ref.commit, git(fixture.repo('orders'), ['rev-parse', 'HEAD']));

    const again = searchV2(fixture.context, request);
    assert.deepEqual(again.items.map((item) => item.ref), first.items.map((item) => item.ref));
    for (const item of first.items) assert.deepEqual(refOf(fixture.context, item.id), item.ref, item.id);
  });

  it('hashes only the identifying fields into the handle', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, ID.same);
    assert.equal(refHandle({ ...ref, path: 'docs/elsewhere.md', commit: '0'.repeat(40), startLine: 99 } as ItemRef), ref.handle);
    assert.notEqual(refHandle({ ...ref, itemSha256: 'a'.repeat(64) }), ref.handle);
    assert.notEqual(refHandle({ ...ref, indexGeneration: 2 }), ref.handle);
    assert.notEqual(refHandle({ ...ref, segmentId: `${ref.itemId}#1` }), ref.handle);
    assert.notEqual(refHandle({ ...ref, indexId: 'f'.repeat(32) }), ref.handle);
  });

  it('changes the handle with the generation and the content', (t) => {
    const fixture = corpus(t);
    const before = { same: refOf(fixture.context, ID.same), changed: refOf(fixture.context, ID.changed) };
    commit(fixture.repo('orders'), { 'docs/a.md': A_AFTER, 'docs/b.md': B_AFTER });
    assert.equal(fixture.index().generation, 2);
    const after = { same: refOf(fixture.context, ID.same), changed: refOf(fixture.context, ID.changed) };

    assert.equal(after.same.itemSha256, before.same.itemSha256);
    assert.notEqual(after.same.handle, before.same.handle);
    assert.equal(after.same.handle, refHandle({ ...before.same, indexGeneration: 2 }));
    assert.notEqual(after.changed.itemSha256, before.changed.itemSha256);
    assert.notEqual(after.changed.handle, refHandle({ ...before.changed, indexGeneration: 2 }));
  });

  it('gives a segment ref a handle different from its item ref', () => {
    const fixture = shared();
    const item = refOf(fixture.context, ID.long);
    const segment = refOf(fixture.context, segmentId(ID.long, 2));
    assert.equal(segment.itemId, item.itemId);
    assert.equal(segment.itemSha256, item.itemSha256);
    assert.notEqual(segment.handle, item.handle);
    assert.equal(refHandle(segment), segment.handle);
  });
});

describe('reference check', () => {
  it('reports refs taken from searchV2 as intact and unchanged', () => {
    const fixture = shared();
    const found = searchV2(fixture.context, { responseVersion: 2, profile: 'master', query: '배송', scope: ORDERS_SCOPE });
    const refs = found.items.map((item) => item.ref);
    const response = verify(fixture.context, refs);

    assert.equal(response.schema, 'agent-knowledge.verify');
    assert.equal(response.schemaVersion, 1);
    assert.equal(response.ok, true);
    assert.equal(response.status, 'ok');
    assert.equal(typeof response.notice, 'string');
    assert.equal(response.indexId, found.index.indexId);
    assert.deepEqual(response.appliedScope.projects, ['orders']);
    assert.deepEqual(response.against, { indexGeneration: 1, activeGeneration: 1 });
    assert.deepEqual(response.summary, { total: refs.length, intact: refs.length, problems: 0, current: { same: refs.length, changed: 0, moved: 0, removed: 0 } });

    response.results.forEach((result, index) => {
      const ref = refs[index]!;
      assert.equal(result.position, index);
      assert.equal(result.handle, ref.handle);
      assert.equal(result.itemId, ref.itemId);
      assert.deepEqual(result.reference.verdict, 'intact');
      assert.deepEqual(result.reference.mismatches, []);
      assert.ok(result.reference.knowledge);
      assert.deepEqual(result.current, {
        indexGeneration: 1,
        state: 'same',
        movedBy: null,
        itemId: ref.itemId,
        itemSha256: ref.itemSha256,
        segment: { state: 'not-requested', segmentId: null, segmentSha256: null },
        candidates: [],
        knowledge: result.reference.knowledge,
      });
    });
  });

  it('accepts a ref with only the required fields and echoes a missing handle as null', () => {
    const fixture = shared();
    const { indexId, indexGeneration, itemId, itemSha256 } = refOf(fixture.context, ID.same);
    const result = only(verify(fixture.context, [{ indexId, indexGeneration, itemId, itemSha256 }]));
    assert.equal(result.handle, null);
    assert.equal(result.reference.verdict, 'intact');
    assert.equal(result.current.state, 'same');
  });

  it('lists exactly the fields that were altered', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, ID.same);
    const altered: [string, Partial<ItemRef>][] = [
      ['itemSha256', { itemSha256: 'a'.repeat(64) }],
      ['documentSha256', { documentSha256: 'b'.repeat(64) }],
      ['blobSha', { blobSha: '0'.repeat(40) }],
      ['path', { path: 'docs/other.md' }],
      ['startLine', { startLine: ref.startLine + 1 }],
      ['endLine', { endLine: ref.endLine + 1 }],
      ['commit', { commit: '1'.repeat(40) }],
      ['sourceId', { sourceId: 'billing' }],
      ['projectId', { projectId: 'billing' }],
    ];
    const response = verify(fixture.context, altered.map(([, change]) => ({ ...ref, ...change })));
    altered.forEach(([field], index) => {
      const result = response.results[index]!;
      assert.equal(result.reference.verdict, 'mismatch', field);
      assert.deepEqual(result.reference.mismatches, [field]);
      assert.ok(result.reference.knowledge, field);
      // 해시를 바꾼 참조는 같은 ID에 다른 내용이 있는 것으로 보인다
      assert.equal(result.current.state, field === 'itemSha256' ? 'changed' : 'same', field);
    });
    assert.deepEqual([response.summary.intact, response.summary.problems], [0, altered.length]);

    const several = only(verify(fixture.context, [{ ...ref, itemSha256: 'c'.repeat(64), path: 'docs/x.md', commit: 'abcdef1', endLine: 1000 }]));
    assert.equal(several.reference.verdict, 'mismatch');
    assert.deepEqual(sorted(several.reference.mismatches), sorted(['itemSha256', 'path', 'commit', 'endLine']));
  });

  it('echoes the handle it was given and keeps the request order', () => {
    const fixture = shared();
    const refs = [refOf(fixture.context, ID.changed), refOf(fixture.context, ID.same)];
    const response = verify(fixture.context, [{ ...refs[0]!, handle: 'ak-00000000000000000000' }, refs[1]]);
    assert.deepEqual(response.results.map((result) => [result.position, result.itemId, result.handle]), [
      [0, ID.changed, 'ak-00000000000000000000'],
      [1, ID.same, refs[1]!.handle],
    ]);
  });

  it('reports other-index for a ref minted by a different index id', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, ID.same);
    for (const indexId of ['f'.repeat(32), null]) {
      const result = only(verify(fixture.context, [{ ...ref, indexId }]));
      assert.deepEqual(result.reference, { verdict: 'other-index', mismatches: [], knowledge: null });
      assert.equal(result.current.state, 'same');
      assert.equal(result.current.itemId, ref.itemId);
    }
    const tampered = only(verify(fixture.context, [{ ...ref, indexId: 'f'.repeat(32), itemSha256: 'a'.repeat(64) }]));
    assert.equal(tampered.reference.verdict, 'other-index');
    assert.equal(tampered.current.state, 'changed');
  });

  it('compares a ref from another database by its content', (t) => {
    const first = shared();
    const second = corpus(t);
    const ref = refOf(first.context, ID.same);
    const response = verify(second.context, [ref]);
    assert.notEqual(response.indexId, ref.indexId);
    const result = only(response);
    assert.equal(result.reference.verdict, 'other-index');
    assert.equal(result.current.state, 'same');
    assert.equal(result.current.itemSha256, ref.itemSha256);
    assert.ok(result.current.knowledge);
  });

  it('reports generation-missing once the generation is collected', (t) => {
    const fixture = corpus(t, 1);
    const refs = [refOf(fixture.context, ID.same), refOf(fixture.context, ID.changed)];
    commit(fixture.repo('orders'), { 'docs/a.md': A_AFTER, 'docs/b.md': B_AFTER });
    assert.equal(fixture.index().generation, 2);

    const response = verify(fixture.context, refs);
    for (const result of response.results) assert.deepEqual(result.reference, { verdict: 'generation-missing', mismatches: [], knowledge: null });
    assert.deepEqual(response.results.map((result) => result.current.state), ['same', 'changed']);
    assert.deepEqual(response.summary, { total: 2, intact: 0, problems: 2, current: { same: 1, changed: 1, moved: 0, removed: 0 } });

    const error = failure(() => verify(fixture.context, refs, { against: { generation: 1 } }), 'index-missing');
    assert.equal(reasonOf(error), 'generation-not-found');
  });

  it('keeps a leased generation verifiable after newer publishes', (t) => {
    const fixture = corpus(t, 1);
    const ref = refOf(fixture.context, ID.changed);
    const store = openForWrite(fixture.dbPath);
    try {
      acquireLease(store, { generation: 1, holder: 'verify-test' });
    } finally {
      store.close();
    }
    commit(fixture.repo('orders'), { 'docs/a.md': A_AFTER });
    fixture.index();
    commit(fixture.repo('orders'), { 'docs/extra.md': '# 추가\n\n추가 문서다.\n' });
    assert.equal(fixture.index().generation, 3);

    const result = only(verify(fixture.context, [ref]));
    assert.equal(result.reference.verdict, 'intact');
    assert.equal(result.current.state, 'changed');
    assert.equal(only(verify(fixture.context, [ref], { against: { generation: 1 } })).current.state, 'same');
    failure(() => verify(fixture.context, [ref], { against: { generation: 2 } }), 'index-missing');
  });

  it('treats an item outside the request scope as not-found and describes nothing of it', () => {
    const fixture = shared();
    const outside = refOf(fixture.context, ID.contract, { scope: { projects: ['billing'] } });
    const missing = { ...outside, itemId: 'billing:docs/none.md#없음', handle: undefined };
    const response = verify(fixture.context, [outside, missing]);
    const [hidden, absent] = response.results as [VerifyResult, VerifyResult];

    assert.deepEqual(hidden.reference, { verdict: 'not-found', mismatches: [], knowledge: null });
    assert.deepEqual(hidden.current, { indexGeneration: 1, state: 'removed', movedBy: null, itemId: null, itemSha256: null, segment: { state: 'not-requested', segmentId: null, segmentSha256: null }, candidates: [], knowledge: null });
    const strip = ({ position: _position, handle: _handle, itemId: _itemId, ...rest }: VerifyResult): unknown => rest;
    assert.deepEqual(strip(hidden), strip(absent));
    assert.deepEqual(response.appliedScope.projects, ['orders']);

    const text = JSON.stringify(response).replaceAll(outside.itemId, '<ref>').replaceAll(missing.itemId, '<ref>');
    for (const secret of [outside.itemSha256, outside.documentSha256, outside.blobSha, outside.commit, 'billing', 'contract', '정산', ID.otherContract]) {
      assert.equal(text.includes(secret), false, secret);
    }
  });

  it('applies the item restriction of an allowed link', () => {
    const fixture = shared();
    const allowed = refOf(fixture.context, ID.contract, { scope: { projects: ['billing'] } });
    const other = refOf(fixture.context, ID.otherContract, { scope: { projects: ['billing'] } });
    const scope = { projects: ['orders'], allowedLinks: [{ project: 'billing', kinds: ['contract'], itemIds: [ID.contract] }] };
    const response = verify(fixture.context, [allowed, other], { scope });
    assert.deepEqual(response.results.map((result) => result.reference.verdict), ['intact', 'not-found']);
    assert.deepEqual(response.results.map((result) => result.current.state), ['same', 'removed']);
    assert.equal(JSON.stringify(response.results[1]).replaceAll(ID.otherContract, '<ref>').includes(other.itemSha256), false);
  });

  it('reports a segment id on an unsplit item as a mismatch', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, ID.same);
    const result = only(verify(fixture.context, [{ ...ref, segmentId: `${ID.same}#1`, segmentSha256: 'a'.repeat(64) }]));
    assert.equal(result.reference.verdict, 'mismatch');
    assert.deepEqual(result.reference.mismatches, ['segmentId']);
    assert.deepEqual(result.current.segment, { state: 'removed', segmentId: null, segmentSha256: null });
  });
});

describe('current check', () => {
  function edited(t: TestContext, activate = true): { fixture: KnowledgeFixture; refs: ItemRef[] } {
    const fixture = corpus(t);
    const refs = [ID.intro, ID.same, ID.changed, ID.moved, ID.removed].map((id) => refOf(fixture.context, id));
    commit(fixture.repo('orders'), { 'docs/a.md': A_AFTER, 'docs/b.md': B_AFTER });
    assert.equal(fixture.index({ activate }).generation, 2);
    return { fixture, refs };
  }

  it('follows edits, moves and removals in the active generation', (t) => {
    const { fixture, refs } = edited(t);
    const response = verify(fixture.context, refs);
    assert.deepEqual(response.against, { indexGeneration: 2, activeGeneration: 2 });
    for (const result of response.results) {
      assert.equal(result.reference.verdict, 'intact', result.itemId);
      assert.equal(result.current.indexGeneration, 2);
    }
    const [intro, same, changed, moved, removed] = response.results as VerifyResult[];
    assert.deepEqual([intro!.current.state, same!.current.state], ['same', 'same']);

    const changedNow = refOf(fixture.context, ID.changed);
    assert.equal(changed!.current.state, 'changed');
    assert.equal(changed!.current.itemId, ID.changed);
    assert.equal(changed!.current.itemSha256, changedNow.itemSha256);
    assert.notEqual(changed!.current.itemSha256, refs[2]!.itemSha256);
    assert.deepEqual(changed!.current.candidates, []);

    assert.equal(moved!.current.state, 'moved');
    assert.equal(moved!.current.itemId, ID.movedTo);
    assert.equal(moved!.current.itemSha256, refs[3]!.itemSha256);
    assert.deepEqual(moved!.current.candidates, [ID.movedTo]);
    assert.ok(moved!.current.knowledge);

    assert.deepEqual(removed!.current, { indexGeneration: 2, state: 'removed', movedBy: null, itemId: null, itemSha256: null, segment: { state: 'not-requested', segmentId: null, segmentSha256: null }, candidates: [], knowledge: null });
    assert.deepEqual(response.summary, { total: 5, intact: 5, problems: 0, current: { same: 2, changed: 1, moved: 1, removed: 1 } });

    // 참조가 주장하는 세대를 그대로 믿지 않는다. 2세대에만 있는 항목을 1세대 참조로 보내면 그 세대에서 찾지 못한다
    const claimed = only(verify(fixture.context, [{ ...refs[3]!, itemId: ID.movedTo, handle: undefined }]));
    assert.deepEqual(claimed.reference, { verdict: 'not-found', mismatches: [], knowledge: null });
    assert.equal(claimed.current.state, 'same');
  });

  it('compares against the generation named in against', (t) => {
    const { fixture, refs } = edited(t);
    const response = verify(fixture.context, refs, { against: { generation: 1 } });
    assert.deepEqual(response.against, { indexGeneration: 1, activeGeneration: 2 });
    assert.deepEqual(response.results.map((result) => result.current.state), ['same', 'same', 'same', 'same', 'same']);
    for (const result of response.results) assert.equal(result.current.indexGeneration, 1);
    failure(() => verify(fixture.context, refs, { against: { generation: 9 } }), 'index-missing');
  });

  it('compares against an inactive generation only when it is named', (t) => {
    const { fixture, refs } = edited(t, false);
    const active = verify(fixture.context, refs);
    assert.deepEqual(active.against, { indexGeneration: 1, activeGeneration: 1 });
    assert.equal(active.summary.current.same, 5);
    const inactive = verify(fixture.context, refs, { against: { generation: 2 } });
    assert.deepEqual(inactive.against, { indexGeneration: 2, activeGeneration: 1 });
    assert.deepEqual(inactive.results.map((result) => result.current.state), ['same', 'same', 'changed', 'moved', 'removed']);
  });

  it('sorts moved candidates by code unit and keeps at most five', (t) => {
    const body = '# 복제 절\n\n복제 본문이다.\n';
    const fixture = small(t, [{ id: 'orders', files: { 'docs/orig.md': body, 'docs/keep.md': '# 남는 문서\n\n남는다.\n' } }]);
    const ref = refOf(fixture.context, 'orders:docs/orig.md#복제-절');
    const copies = ['docs/z9.md', 'docs/z10.md', 'docs/m.md', 'docs/_u.md', 'docs/가.md', 'docs/a.md'];
    commit(fixture.repo('orders'), { 'docs/orig.md': null, ...Object.fromEntries(copies.map((path) => [path, body])) });
    fixture.index();

    const { current } = only(verify(fixture.context, [ref]));
    const expected = sorted(copies.map((path) => `orders:${path}#복제-절`)).slice(0, 5);
    assert.deepEqual(expected, ['orders:docs/_u.md#복제-절', 'orders:docs/a.md#복제-절', 'orders:docs/m.md#복제-절', 'orders:docs/z10.md#복제-절', 'orders:docs/z9.md#복제-절']);
    assert.equal(current.state, 'moved');
    assert.deepEqual(current.candidates, expected);
    assert.equal(current.itemId, expected[0]);
    assert.equal(current.itemSha256, ref.itemSha256);
  });

  it('offers moved candidates only from inside the scope', (t) => {
    const body = '# 공통 절\n\n공통 본문이다.\n';
    const fixture = small(t, [
      { id: 'orders', files: { 'docs/shared.md': body, 'docs/keep.md': '# 남는 문서\n\n남는다.\n' } },
      { id: 'billing', files: { 'docs/copy.md': body } },
    ]);
    const { sourceId: _sourceId, ...ref } = refOf(fixture.context, 'orders:docs/shared.md#공통-절');
    commit(fixture.repo('orders'), { 'docs/shared.md': null });
    fixture.index();

    const hidden = only(verify(fixture.context, [ref]));
    assert.equal(hidden.current.state, 'removed');
    assert.deepEqual(hidden.current.candidates, []);
    assert.equal(JSON.stringify(hidden).includes('copy.md'), false);

    const restricted = only(verify(fixture.context, [ref], { scope: { projects: ['orders'], allowedLinks: [{ project: 'billing', kinds: ['reference'], itemIds: ['billing:docs/none.md#없음'] }] } }));
    assert.equal(restricted.current.state, 'removed');

    const linked = only(verify(fixture.context, [ref], { scope: { projects: ['orders'], allowedLinks: [{ project: 'billing', kinds: ['reference'] }] } }));
    assert.equal(linked.current.state, 'moved');
    assert.deepEqual(linked.current.candidates, ['billing:docs/copy.md#공통-절']);
  });

  it('reports an entry whose key moved to another document as moved', (t) => {
    const entry = (body: string): string => `### \`BR-777\` 취소 기한\n\n${body}\n`;
    const fixture = small(t, [{ id: 'orders', files: { 'docs/rules.md': `# 규칙\n\n규칙 모음이다.\n\n${entry('배송 전이면 취소할 수 있다.')}` } }]);
    const [found] = searchV2(fixture.context, { responseVersion: 2, profile: 'master', query: 'BR-777', scope: ORDERS_SCOPE }).items;
    assert.equal(found?.key, 'BR-777');
    commit(fixture.repo('orders'), { 'docs/rules.md': '# 규칙\n\n규칙 모음이다.\n', 'docs/moved.md': `# 옮긴 규칙\n\n${entry('배송 뒤에는 취소할 수 없다.')}` });
    fixture.index();
    const [movedTo] = searchV2(fixture.context, { responseVersion: 2, profile: 'master', query: 'BR-777', scope: ORDERS_SCOPE }).items;
    assert.equal(movedTo?.key, 'BR-777');
    assert.notEqual(movedTo.id, found.id);

    // 다른 범위 안 ID에 같은 해시가 있거나 같은 키가 있으면 moved다
    const { current } = only(verify(fixture.context, [found.ref]));
    assert.equal(current.state, 'moved');
    assert.equal(current.itemId, movedTo.id);
    assert.deepEqual(current.candidates, [movedTo.id]);
  });
});

describe('segment references', () => {
  it('gets a segment by its id together with the whole item', () => {
    const fixture = shared();
    const response = lookup(fixture.context, segmentId(ID.long, 2));
    const { item } = response;
    assert.equal(response.schemaVersion, 2);
    assert.equal(item.id, ID.long);
    assert.equal(item.group, 'lookup');
    assert.equal(item.content, LONG.trimEnd());
    assert.equal(item.segmentContent, BETA);
    assert.deepEqual(item.segment, { id: segmentId(ID.long, 2), ordinal: 2, count: 2, startLine: 5, endLine: 5, sha256: sha(BETA), heading: null });
    assert.deepEqual([item.ref.segmentId, item.ref.segmentSha256, item.ref.segmentStartLine, item.ref.segmentEndLine], [segmentId(ID.long, 2), sha(BETA), 5, 5]);
    assert.equal(item.ref.itemSha256, sha(LONG.trimEnd()));

    const first = lookup(fixture.context, segmentId(ID.long, 1)).item;
    assert.equal(first.segmentContent, `# 긴 문서\n\n${ALPHA}`);
    assert.deepEqual(first.segment, { id: segmentId(ID.long, 1), ordinal: 1, count: 2, startLine: 1, endLine: 3, sha256: sha(`# 긴 문서\n\n${ALPHA}`), heading: '긴 문서' });

    const whole = lookup(fixture.context, ID.long).item;
    assert.equal(whole.segment, null);
    assert.equal(whole.segmentContent, null);
    assert.equal(whole.ref.segmentId, null);
  });

  it('verifies an unchanged segment ref as intact and the same', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, segmentId(ID.long, 2));
    const result = only(verify(fixture.context, [ref]));
    assert.equal(result.reference.verdict, 'intact');
    assert.equal(result.current.state, 'same');
    assert.deepEqual(result.current.segment, { state: 'same', segmentId: ref.segmentId, segmentSha256: ref.segmentSha256 });
  });

  it('lists altered segment fields', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, segmentId(ID.long, 2));
    const altered: [string, Partial<ItemRef>][] = [
      ['segmentSha256', { segmentSha256: 'a'.repeat(64) }],
      ['segmentStartLine', { segmentStartLine: 4 }],
      ['segmentEndLine', { segmentEndLine: 6 }],
      ['segmentId', { segmentId: segmentId(ID.long, 9) }],
    ];
    const response = verify(fixture.context, altered.map(([, change]) => ({ ...ref, ...change })));
    altered.forEach(([field], index) => assert.deepEqual(response.results[index]!.reference.mismatches, [field], field));
    // 같은 내용이 다른 조각 ID에 있으므로 조각은 옮겨진 것으로 보인다
    assert.deepEqual(response.results[3]!.current.segment, { state: 'moved', segmentId: segmentId(ID.long, 2), segmentSha256: ref.segmentSha256 });
    assert.deepEqual(response.results[0]!.current.segment, { state: 'changed', segmentId: segmentId(ID.long, 2), segmentSha256: ref.segmentSha256 });
  });

  it('follows a segment that shifted after an insertion', (t) => {
    const fixture = corpus(t);
    const refs = [refOf(fixture.context, segmentId(ID.long, 1)), refOf(fixture.context, segmentId(ID.long, 2))];
    commit(fixture.repo('orders'), { 'docs/long.md': `# 긴 문서\n\n${GAMMA}\n\n${ALPHA}\n\n${BETA}\n` });
    fixture.index();
    assert.equal(lookup(fixture.context, ID.long).item.ref.itemSha256 !== refs[0]!.itemSha256, true);

    const [first, second] = verify(fixture.context, refs).results as [VerifyResult, VerifyResult];
    assert.equal(first.current.state, 'changed');
    const nowFirst = lookup(fixture.context, segmentId(ID.long, 1)).item.segment!;
    assert.deepEqual(first.current.segment, { state: 'changed', segmentId: segmentId(ID.long, 1), segmentSha256: nowFirst.sha256 });
    assert.equal(second.current.state, 'changed');
    assert.deepEqual(second.current.segment, { state: 'moved', segmentId: segmentId(ID.long, 3), segmentSha256: sha(BETA) });
  });

  it('reports the segment removed when the item is no longer split', (t) => {
    const fixture = corpus(t);
    const ref = refOf(fixture.context, segmentId(ID.long, 2));
    commit(fixture.repo('orders'), { 'docs/long.md': `# 긴 문서\n\n${ALPHA}\n` });
    fixture.index();
    assert.equal(lookup(fixture.context, ID.long).item.segment, null);
    failure(() => lookup(fixture.context, segmentId(ID.long, 2)), 'not-found');

    const { current } = only(verify(fixture.context, [ref]));
    assert.equal(current.state, 'changed');
    assert.deepEqual(current.segment, { state: 'removed', segmentId: null, segmentSha256: null });
  });

  it('reports the segment of a moved item under the new item id', (t) => {
    const fixture = corpus(t);
    const ref = refOf(fixture.context, segmentId(ID.long, 2));
    commit(fixture.repo('orders'), { 'docs/long.md': null, 'docs/long2.md': LONG });
    fixture.index();
    const { current } = only(verify(fixture.context, [ref]));
    const newId = 'orders:docs/long2.md#긴-문서';
    assert.equal(current.state, 'moved');
    assert.equal(current.itemId, newId);
    assert.deepEqual(current.segment, { state: 'moved', segmentId: segmentId(newId, 2), segmentSha256: sha(BETA) });
  });

  it('reports the segment removed together with its item', (t) => {
    const fixture = corpus(t);
    const ref = refOf(fixture.context, segmentId(ID.long, 2));
    commit(fixture.repo('orders'), { 'docs/long.md': null });
    fixture.index();
    const { current } = only(verify(fixture.context, [ref]));
    assert.equal(current.state, 'removed');
    assert.deepEqual(current.segment, { state: 'removed', segmentId: null, segmentSha256: null });
  });

  it('puts the best segment into search refs when segments are on', () => {
    const fixture = shared();
    const request = { responseVersion: 2 as const, profile: 'master' as const, query: '베타', scope: ORDERS_SCOPE };
    const split = searchV2(fixture.context, { ...request, segments: true }).items.find((item) => item.id === ID.long);
    assert.ok(split);
    assert.equal(split.segment?.id, segmentId(ID.long, 2));
    assert.equal(split.ref.segmentId, segmentId(ID.long, 2));
    assert.equal(split.ref.segmentSha256, sha(BETA));
    const result = only(verify(fixture.context, [split.ref]));
    assert.equal(result.reference.verdict, 'intact');
    assert.equal(result.current.segment.state, 'same');

    const whole = searchV2(fixture.context, request).items.find((item) => item.id === ID.long);
    assert.equal(whole?.ref.segmentId, null);
    assert.equal(only(verify(fixture.context, [whole!.ref])).current.segment.state, 'not-requested');
  });

  it('requires segmentSha256 whenever a segmentId is given', () => {
    const fixture = shared();
    const { segmentSha256: _segmentSha256, ...ref } = refOf(fixture.context, segmentId(ID.long, 2));
    // segmentId와 segmentSha256은 함께 필수다. 해시 없이 받으면 그대로인 조각도 changed로 보인다
    failure(() => verify(fixture.context, [ref]), 'invalid-request');
  });
});

describe('knowledge in verify results', () => {
  const WORD = '공통단어';
  const entry = (key: string, fields: string[]): string => [`### \`${key}\` ${key} 항목`, ...fields.map((field) => `- ${field}`), '', `${WORD} 본문이다.`, ''].join('\n');
  const STATED = ['상태: 확정', '근거: docs/evidence.md'];

  it('never reports unverified, deprecated, conflicted or observed items as confirmed', (t) => {
    const fixture = small(t, [
      {
        id: 'orders',
        files: {
          'docs/evidence.md': '# 근거 자료\n\n존재하는 근거 문서다.\n',
          'src/a.ts': 'export const a = 1;\n',
          'docs/items.md': [
            '# 항목',
            '',
            entry('OK-1', STATED),
            entry('OK-2', ['상태: 검증됨', '근거: docs/evidence.md']),
            entry('NO-BASIS', ['상태: 확정']),
            entry('UNVERIFIED', ['상태: 미확인', '근거: docs/evidence.md']),
            entry('OBSERVED', ['상태: 관찰', '코드: src/a.ts']),
            entry('GONE', ['상태: 폐기', '근거: docs/evidence.md']),
            entry('CLASH-A', [...STATED, '충돌: `CLASH-B`']),
            entry('CLASH-B', STATED),
            entry('DUP', STATED),
            entry('DUP', STATED),
          ].join('\n'),
        },
      },
    ]);
    const found = searchV2(fixture.context, { responseVersion: 2, profile: 'master', query: WORD, scope: ORDERS_SCOPE, filters: { statuses: [...EFFECTIVE_STATUSES] }, limit: 50 });
    const response = verify(fixture.context, found.items.map((item) => item.ref));
    const seen = new Set<EffectiveStatus>();
    response.results.forEach((result, index) => {
      const item = found.items[index]!;
      seen.add(item.knowledge.status);
      const expected = { status: item.knowledge.status, confirmed: item.knowledge.confirmed };
      assert.deepEqual(result.reference.knowledge, expected, item.id);
      assert.deepEqual(result.current.knowledge, expected, item.id);
      if (NEVER_CONFIRMED.includes(item.knowledge.status)) {
        assert.equal(result.reference.knowledge?.confirmed, false, item.id);
        assert.equal(result.current.knowledge?.confirmed, false, item.id);
      }
      assert.equal(result.reference.knowledge?.confirmed, ['confirmed_policy', 'verified_experience'].includes(item.knowledge.status), item.id);
    });
    for (const status of [...NEVER_CONFIRMED, 'confirmed_policy', 'verified_experience'] as const) assert.ok(seen.has(status), status);
  });

  it('reports knowledge at the referenced and at the current generation separately', (t) => {
    const fixture = small(t, [
      {
        id: 'orders',
        files: {
          'docs/evidence.md': '# 근거 자료\n\n존재하는 근거 문서다.\n',
          'docs/a.md': `# 가\n\n${entry('OK-1', STATED)}`,
          'docs/old.md': `# 나\n\n${entry('OLD', STATED)}`,
          'docs/keep.md': `# 다\n\n${entry('KEEP', ['상태: 확정', '근거: docs/keep.md'])}`,
        },
      },
    ]);
    const refs = ['orders:docs/a.md#OK-1', 'orders:docs/old.md#OLD'].map((id) => refOf(fixture.context, id));
    commit(fixture.repo('orders'), { 'docs/evidence.md': null, 'docs/new.md': `# 라\n\n${entry('NEW', ['상태: 확정', '근거: docs/keep.md', '대체: `OLD`'])}` });
    fixture.index();

    const [confirmedThen, supersededNow] = verify(fixture.context, refs).results as [VerifyResult, VerifyResult];
    assert.deepEqual(confirmedThen.reference.knowledge, { status: 'confirmed_policy', confirmed: true });
    assert.equal(confirmedThen.current.state, 'same');
    assert.deepEqual(confirmedThen.current.knowledge, { status: 'unverified', confirmed: false });
    assert.deepEqual(supersededNow.reference.knowledge, { status: 'confirmed_policy', confirmed: true });
    assert.equal(supersededNow.current.state, 'same');
    assert.deepEqual(supersededNow.current.knowledge, { status: 'deprecated', confirmed: false });
  });
});

describe('verify request validation', () => {
  it('rejects malformed requests as invalid-request', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, ID.same);
    const { indexGeneration: _indexGeneration, ...withoutGeneration } = ref;
    const { indexId: _indexId, ...withoutIndexId } = ref;
    const base = { profile: 'master', scope: ORDERS_SCOPE };
    const cases: [string, unknown][] = [
      ['no references', base],
      ['empty references', { ...base, references: [] }],
      ['too many references', { ...base, references: Array.from({ length: MAX_REFERENCES + 1 }, () => ref) }],
      ['references not an array', { ...base, references: ref }],
      ['uppercase itemSha256', { ...base, references: [{ ...ref, itemSha256: ref.itemSha256.toUpperCase() }] }],
      ['short itemSha256', { ...base, references: [{ ...ref, itemSha256: ref.itemSha256.slice(1) }] }],
      ['bad segmentSha256', { ...base, references: [{ ...ref, segmentId: `${ref.itemId}#1`, segmentSha256: 'xyz' }] }],
      ['bad documentSha256', { ...base, references: [{ ...ref, documentSha256: 'nothex' }] }],
      ['missing indexGeneration', { ...base, references: [withoutGeneration] }],
      ['missing indexId', { ...base, references: [withoutIndexId] }],
      ['zero indexGeneration', { ...base, references: [{ ...ref, indexGeneration: 0 }] }],
      ['empty itemId', { ...base, references: [{ ...ref, itemId: '' }] }],
      ['string startLine', { ...base, references: [{ ...ref, startLine: String(ref.startLine) }] }],
      ['unknown request field', { ...base, references: [ref], extra: true }],
      ['zero against generation', { ...base, references: [ref], against: { generation: 0 } }],
      ['unknown against field', { ...base, references: [ref], against: { generation: 1, exact: true } }],
      ['unknown profile', { ...base, profile: 'other', references: [ref] }],
      ['null request', null],
      ['array request', [ref]],
    ];
    for (const [name, raw] of cases) {
      const error = failure(() => verifyReferences(fixture.context, raw), 'invalid-request');
      assert.ok(Array.isArray((error.detail as { issues?: unknown }).issues), name);
    }
  });

  it('accepts exactly MAX_REFERENCES references', () => {
    const fixture = shared();
    assert.equal(MAX_REFERENCES, 256);
    const ref = refOf(fixture.context, ID.same);
    const response = verify(fixture.context, Array.from({ length: MAX_REFERENCES }, () => ref));
    assert.deepEqual(response.summary, { total: 256, intact: 256, problems: 0, current: { same: 256, changed: 0, moved: 0, removed: 0 } });
    assert.deepEqual(response.results.map((result) => result.position), Array.from({ length: 256 }, (_, index) => index));
  });

  it('rejects a malformed or unknown scope as invalid-scope', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, ID.same);
    failure(() => verify(fixture.context, [ref], { scope: { projects: [] } }), 'invalid-scope');
    failure(() => verify(fixture.context, [ref], { scope: { projects: ['nobody'] } }), 'invalid-scope');
    failure(() => verify(fixture.context, [ref], { profile: 'code', scope: { projects: ['orders', 'billing'] } }), 'invalid-scope');
  });
});

describe('get v2', () => {
  it('looks up an item id in the lookup group with a ref and the full content', () => {
    const fixture = shared();
    const response = lookup(fixture.context, ID.same);
    const v1 = getItem(fixture.context, { id: ID.same, profile: 'master', scope: ORDERS_SCOPE });
    assert.equal(response.schema, 'agent-knowledge.get');
    assert.equal(response.schemaVersion, 2);
    assert.equal(response.status, 'ok');
    const { item } = response;
    assert.equal(item.id, ID.same);
    assert.equal(item.group, 'lookup');
    assert.equal(item.content, v1.item.content);
    assert.equal(item.content, '## 그대로 절\n\n배송 그대로 본문이다.');
    assert.deepEqual(item.selection.reasons, ['id-lookup']);
    assert.equal(item.selection.directRank, null);
    assert.deepEqual(item.selection.matchedQueries, []);
    assert.equal(item.segment, null);
    assert.equal(item.segmentContent, null);
    assert.equal(item.ref.itemId, ID.same);
    assert.equal(item.ref.itemSha256, sha(item.content));
    assert.equal(item.ref.itemSha256, v1.item.provenance.itemSha256);
    assert.equal(response.index.indexId, item.ref.indexId);
    assert.deepEqual(response.index.selection, { by: 'active', exact: false });
    assert.equal(only(verify(fixture.context, [item.ref])).reference.verdict, 'intact');
  });

  it('refuses content that differs from the expected hash', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, segmentId(ID.long, 2));
    assert.equal(lookup(fixture.context, ID.long, { expect: { itemSha256: ref.itemSha256 } }).item.id, ID.long);
    assert.equal(lookup(fixture.context, segmentId(ID.long, 2), { expect: { itemSha256: ref.itemSha256, segmentSha256: ref.segmentSha256 } }).item.segment?.ordinal, 2);

    const cases: [string, Record<string, string>, string[]][] = [
      [ID.long, { itemSha256: 'a'.repeat(64) }, ['itemSha256']],
      [ID.long, { segmentSha256: ref.segmentSha256! }, ['segmentSha256']],
      [segmentId(ID.long, 2), { segmentSha256: 'b'.repeat(64) }, ['segmentSha256']],
      [segmentId(ID.long, 2), { itemSha256: 'a'.repeat(64), segmentSha256: 'b'.repeat(64) }, ['itemSha256', 'segmentSha256']],
    ];
    for (const [id, expect, fields] of cases) {
      const error = failure(() => lookup(fixture.context, id, { expect }), 'invalid-request');
      assert.deepEqual(error.detail, { reason: 'hash-mismatch', id, fields });
    }
    const malformed = failure(() => lookup(fixture.context, ID.long, { expect: { itemSha256: ref.itemSha256.toUpperCase() } }), 'invalid-request');
    assert.notEqual(reasonOf(malformed), 'hash-mismatch');
    failure(() => lookup(fixture.context, ID.long, { expect: { other: 'x' } }), 'invalid-request');
  });

  it('reports unknown and out-of-scope ids alike as not-found', () => {
    const fixture = shared();
    const ids = ['orders:docs/none.md#없음', segmentId(ID.long, 99), segmentId(ID.same, 1), ID.contract, segmentId(ID.billingLong, 2), `${ID.long}~1`];
    assert.equal(lookup(fixture.context, segmentId(ID.billingLong, 2), { scope: { projects: ['billing'] } }).item.id, ID.billingLong);
    const messages = new Set<string>();
    for (const id of ids) {
      const error = failure(() => lookup(fixture.context, id), 'not-found');
      assert.deepEqual(error.detail, { id });
      messages.add(error.message);
    }
    assert.equal(messages.size, 1);
    // 범위 밖 항목의 해시 검사가 먼저 돌면 그 존재가 드러난다
    const hidden = failure(() => lookup(fixture.context, ID.contract, { expect: { itemSha256: 'a'.repeat(64) } }), 'not-found');
    assert.deepEqual(hidden.detail, { id: ID.contract });
  });

  it('keeps getItem and getItemV2 on their own response versions', () => {
    const fixture = shared();
    assert.equal(reasonOf(failure(() => getItem(fixture.context, { responseVersion: 2, id: ID.same, profile: 'master', scope: ORDERS_SCOPE }), 'invalid-request')), 'use-get-v2');
    assert.equal(reasonOf(failure(() => getItemV2(fixture.context, { id: ID.same, profile: 'master', scope: ORDERS_SCOPE }), 'invalid-request')), 'response-version-2-required');
    assert.equal(reasonOf(failure(() => getItem(fixture.context, { id: ID.same, profile: 'master', scope: ORDERS_SCOPE, expect: { itemSha256: 'a'.repeat(64) } }), 'invalid-request')), 'response-version-2-required');
    assert.equal(reasonOf(failure(() => getItemV2(fixture.context, { responseVersion: 3, id: ID.same, profile: 'master', scope: ORDERS_SCOPE }), 'invalid-request')), 'unsupported-response-version');
    failure(() => lookup(fixture.context, ID.same, { version: { generation: 1, unknown: true } }), 'invalid-request');
  });

  it('honours version.indexId', () => {
    const fixture = shared();
    const { indexId } = refOf(fixture.context, ID.same);
    assert.equal(lookup(fixture.context, ID.same, { version: { indexId } }).index.indexId, indexId);
    const other = indexId === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32);
    const error = failure(() => lookup(fixture.context, ID.same, { version: { indexId: other } }), 'index-missing');
    assert.deepEqual(error.detail, { reason: 'index-id-mismatch', expected: other, actual: indexId });
    failure(() => lookup(fixture.context, ID.same, { version: { indexId: 'not-an-index-id' } }), 'invalid-request');
  });

  it('honours version.exact for a named generation', (t) => {
    const fixture = corpus(t);
    const firstCommit = git(fixture.repo('orders'), ['rev-parse', 'HEAD']);
    const secondCommit = commit(fixture.repo('orders'), { 'docs/a.md': A_AFTER });
    fixture.index();

    failure(() => lookup(fixture.context, ID.changed, { version: { exact: true } }), 'invalid-request');
    const current = lookup(fixture.context, ID.changed);
    assert.equal(current.index.generation, 2);
    assert.match(current.item.content, /변경 후/);

    const exact = lookup(fixture.context, ID.changed, { version: { generation: 1, exact: true } });
    assert.equal(exact.index.generation, 1);
    assert.deepEqual(exact.index.selection, { by: 'generation', exact: true });
    assert.match(exact.item.content, /변경 전/);
    assert.equal(exact.item.ref.indexGeneration, 1);
    assert.equal(exact.item.ref.commit, firstCommit);

    const matching = lookup(fixture.context, ID.changed, { version: { generation: 1, exact: true, commits: { orders: firstCommit.slice(0, 7) } } });
    assert.deepEqual([matching.index.generation, matching.index.selection], [1, { by: 'generation+commits', exact: true }]);
    const mismatch = failure(() => lookup(fixture.context, ID.changed, { version: { generation: 1, exact: true, commits: { orders: secondCommit } } }), 'index-missing');
    assert.equal(reasonOf(mismatch), 'commit-not-in-generation');

    const byCommit = lookup(fixture.context, ID.changed, { version: { commits: { orders: firstCommit } } });
    assert.deepEqual([byCommit.index.generation, byCommit.index.selection], [1, { by: 'commits', exact: false }]);
  });
});

describe('verify CLI', () => {
  interface Run {
    status: number;
    stdout: string;
    doc: Record<string, any>;
  }

  function run(args: readonly string[], input?: string): Run {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_KNOWLEDGE_')));
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, input, env });
    assert.equal(result.error, undefined);
    assert.equal(result.stdout.endsWith('\n'), true, result.stdout);
    assert.equal(result.stdout.trimEnd().includes('\n'), false, result.stdout);
    return { status: result.status!, stdout: result.stdout, doc: JSON.parse(result.stdout) as Record<string, any> };
  }

  const dbArgs = (fixture: KnowledgeFixture): string[] => ['--config', fixture.space.path('absent.yaml'), '--db', fixture.dbPath];

  it('verifies a request file and exits 0 even when a reference is broken', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, ID.same);
    const file = fixture.space.path('verify.json');
    writeFileSync(file, JSON.stringify({ profile: 'master', scope: ORDERS_SCOPE, references: [ref, { ...ref, path: 'docs/other.md' }] }));

    const result = run(['verify', ...dbArgs(fixture), '--request', file]);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.doc.schema, 'agent-knowledge.verify');
    assert.equal(result.doc.schemaVersion, 1);
    assert.deepEqual(result.doc.results.map((entry: VerifyResult) => entry.reference.verdict), ['intact', 'mismatch']);
    assert.deepEqual(result.doc.results[1].reference.mismatches, ['path']);
    assert.deepEqual(result.doc.summary, { total: 2, intact: 1, problems: 1, current: { same: 2, changed: 0, moved: 0, removed: 0 } });
    assert.deepEqual(result.doc, JSON.parse(JSON.stringify(verify(fixture.context, [ref, { ...ref, path: 'docs/other.md' }]))));
  });

  it('reads the request from stdin', () => {
    const fixture = shared();
    const ref = refOf(fixture.context, ID.same);
    const result = run(['verify', ...dbArgs(fixture), '--request', '-'], JSON.stringify({ profile: 'master', scope: ORDERS_SCOPE, references: [ref] }));
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.doc.results[0].reference.verdict, 'intact');
  });

  const assertMissingRequest = (result: Run): void => {
    assert.equal(result.doc.schema, 'agent-knowledge.error', result.stdout);
    assert.equal(result.doc.command, 'verify');
    assert.equal(result.doc.error.code, 'usage', result.stdout);
    assert.deepEqual(result.doc.error.detail, { flag: 'request' });
    assert.equal(result.status, EXIT_CODES.usage);
  };

  it('requires --request', () => {
    assertMissingRequest(run(['verify', ...dbArgs(shared())]));
  });

  it('reports a missing --request before it loads any configuration', (t) => {
    // search와 get은 설정을 읽기 전에 요청 옵션부터 검사한다. verify도 같아야 사용법 오류가 설정 오류에 가려지지 않는다
    assertMissingRequest(run(['verify', '--config', tempSpace(t).path('absent.yaml')]));
  });

  it('rejects request options that verify does not take', () => {
    const result = run(['verify', '--request', '-', '--project', 'orders'], '{}');
    assert.equal(result.status, EXIT_CODES.usage);
    assert.equal(result.doc.error.code, 'usage');
  });

  it('reports an invalid request file with the invalid-request exit code', () => {
    const fixture = shared();
    const file = fixture.space.path('broken.json');
    writeFileSync(file, '{ not json');
    const broken = run(['verify', ...dbArgs(fixture), '--request', file]);
    assert.equal(broken.status, EXIT_CODES['invalid-request']);
    assert.equal(broken.doc.error.code, 'invalid-request');
    assert.equal(broken.doc.error.detail.reason, 'request-not-json');

    writeFileSync(file, JSON.stringify({ profile: 'master', scope: ORDERS_SCOPE, references: [] }));
    const empty = run(['verify', ...dbArgs(fixture), '--request', file]);
    assert.equal(empty.status, EXIT_CODES['invalid-request']);
    assert.equal(empty.doc.command, 'verify');
  });
});
