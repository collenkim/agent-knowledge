import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { KnowledgeError } from '../src/errors.js';
import type { BaseStatus, Kind, SourceRule } from '../src/model.js';
import { resolveBaseStatus, resolveGeneration, type BasisResult, type GenerationItem, type ResolvedItem, type SourceFacts, type StatusInput } from '../src/indexing/resolve.js';
import { buildDocumentItems } from '../src/parsing/build-items.js';
import { loadSourcesConfig } from '../src/sources/config.js';
import { tempSpace } from './helpers.js';

const PATH_OK: BasisResult = { kind: 'path', value: 'docs/x.md', resolved: true };
const PATH_BAD: BasisResult = { kind: 'path', value: 'docs/none.md', resolved: false };
const CODE_OK = { resolved: true };
const CODE_BAD = { resolved: false };

function rule(status?: BaseStatus, basis?: string): SourceRule {
  return { match: 'doc/*.md', ...(status ? { status } : {}), ...(basis === undefined ? {} : { basis }) };
}

type Row = [name: string, input: Partial<StatusInput>, status: BaseStatus, reason: string];

const TABLE: Row[] = [
  // 선언된 폐기는 무엇으로도 뒤집지 못한다
  ['declared deprecated', { declared: 'deprecated', rawDeclared: '폐기' }, 'deprecated', 'declared-deprecated'],
  ['declared deprecated beats a confirming rule', { declared: 'deprecated', rawDeclared: '폐기', rule: rule('confirmed_policy', '운영자') }, 'deprecated', 'declared-deprecated'],
  // 상태 없음
  ['nothing declared', {}, 'unverified', 'status-not-declared'],
  ['unknown value', { rawDeclared: '확정 예정' }, 'unverified', 'unknown-status-value'],
  ['unknown value with a resolved basis', { rawDeclared: '확정 예정', basis: [PATH_OK] }, 'unverified', 'unknown-status-value'],
  ['rule without status leaves nothing declared', { rule: rule() }, 'unverified', 'status-not-declared'],
  // 미확인
  ['declared unverified', { declared: 'unverified', rawDeclared: '미확인' }, 'unverified', 'declared'],
  ['rule cannot lift 미확인', { declared: 'unverified', rawDeclared: '미확인', rule: rule('confirmed_policy', '운영자') }, 'unverified', 'declared-overrides-source-rule'],
  ['rule cannot lift 미확인 even with a resolved basis', { declared: 'unverified', rawDeclared: '미확인', basis: [PATH_OK], rule: rule('verified_experience', '운영자') }, 'unverified', 'declared-overrides-source-rule'],
  ['rule cannot retire 미확인', { declared: 'unverified', rawDeclared: '미확인', rule: rule('deprecated') }, 'unverified', 'declared-overrides-source-rule'],
  ['rule unverified without declaration', { rule: rule('unverified') }, 'unverified', 'source-rule'],
  ['rule unverified lowers a declared confirmed', { declared: 'confirmed_policy', rawDeclared: '확정', basis: [PATH_OK], rule: rule('unverified') }, 'unverified', 'source-rule'],
  ['rule deprecated', { rule: rule('deprecated') }, 'deprecated', 'source-rule'],
  ['rule deprecated retires a declared confirmed', { declared: 'confirmed_policy', rawDeclared: '확정', rule: rule('deprecated') }, 'deprecated', 'source-rule'],
  // 관찰
  ['observed with code', { declared: 'observed_behavior', rawDeclared: '관찰', codeLinks: [CODE_OK] }, 'observed_behavior', 'code-reference-resolved'],
  ['observed with one of two code links', { declared: 'observed_behavior', rawDeclared: '관찰', codeLinks: [CODE_BAD, CODE_OK] }, 'observed_behavior', 'code-reference-resolved'],
  ['observed with basis only', { declared: 'observed_behavior', rawDeclared: '관찰', basis: [PATH_OK] }, 'observed_behavior', 'basis-resolved'],
  ['observed prefers the code reason', { declared: 'observed_behavior', rawDeclared: '관찰', basis: [PATH_OK], codeLinks: [CODE_OK] }, 'observed_behavior', 'code-reference-resolved'],
  ['observed without anything', { declared: 'observed_behavior', rawDeclared: '관찰' }, 'unverified', 'observation-without-code-reference'],
  ['observed with unresolved references', { declared: 'observed_behavior', rawDeclared: '관찰', basis: [PATH_BAD], codeLinks: [CODE_BAD] }, 'unverified', 'observation-without-code-reference'],
  ['rule cannot lift 관찰', { declared: 'observed_behavior', rawDeclared: '관찰', codeLinks: [CODE_OK], rule: rule('confirmed_policy', '운영자') }, 'observed_behavior', 'declared-overrides-source-rule'],
  ['rule cannot lift 관찰 without code', { declared: 'observed_behavior', rawDeclared: '관찰', rule: rule('confirmed_policy', '운영자') }, 'unverified', 'observation-without-code-reference'],
  ['rule observed with code', { codeLinks: [CODE_OK], rule: rule('observed_behavior') }, 'observed_behavior', 'code-reference-resolved'],
  ['rule observed with basis lowers a declared confirmed', { declared: 'confirmed_policy', rawDeclared: '확정', basis: [PATH_OK], rule: rule('observed_behavior') }, 'observed_behavior', 'basis-resolved'],
  ['rule observed without references', { rule: rule('observed_behavior') }, 'unverified', 'observation-without-code-reference'],
  // 확정과 검증
  ['confirmed with basis', { declared: 'confirmed_policy', rawDeclared: '확정', basis: [PATH_BAD, PATH_OK] }, 'confirmed_policy', 'basis-resolved'],
  ['verified with basis', { declared: 'verified_experience', rawDeclared: '검증됨', basis: [PATH_OK] }, 'verified_experience', 'basis-resolved'],
  ['resolved basis wins over the rule reason', { declared: 'confirmed_policy', rawDeclared: '확정', basis: [PATH_OK], rule: rule('confirmed_policy', '운영자') }, 'confirmed_policy', 'basis-resolved'],
  ['confirmed by rule alone', { rule: rule('confirmed_policy', '운영자') }, 'confirmed_policy', 'source-rule'],
  ['verified by rule alone', { rule: rule('verified_experience', '운영자') }, 'verified_experience', 'source-rule'],
  ['rule replaces a declared verified', { declared: 'verified_experience', rawDeclared: '검증됨', rule: rule('confirmed_policy', '운영자') }, 'confirmed_policy', 'source-rule'],
  // 작성자가 어휘 밖의 값을 적었으면 규칙이 그 항목을 올리지 못하고 낮추기만 한다
  ['rule cannot confirm an unknown value', { rawDeclared: '확정 예정', rule: rule('confirmed_policy', '운영자') }, 'unverified', 'unknown-status-value'],
  ['rule cannot verify an unknown value', { rawDeclared: '초안', rule: rule('verified_experience', '운영자') }, 'unverified', 'unknown-status-value'],
  ['rule cannot make an unknown value observed', { rawDeclared: '초안', codeLinks: [CODE_OK], rule: rule('observed_behavior') }, 'unverified', 'unknown-status-value'],
  ['rule lowers an unknown value to unverified', { rawDeclared: '초안', rule: rule('unverified') }, 'unverified', 'source-rule'],
  ['rule retires an unknown value', { rawDeclared: '초안', rule: rule('deprecated') }, 'deprecated', 'source-rule'],
  ['declared confirmed without basis', { declared: 'confirmed_policy', rawDeclared: '확정' }, 'unverified', 'status-basis-missing'],
  ['declared verified without basis', { declared: 'verified_experience', rawDeclared: '검증됨' }, 'unverified', 'status-basis-missing'],
  ['declared confirmed with unresolved basis', { declared: 'confirmed_policy', rawDeclared: '확정', basis: [PATH_BAD] }, 'unverified', 'status-basis-unresolved'],
  ['code link does not confirm', { declared: 'confirmed_policy', rawDeclared: '확정', codeLinks: [CODE_OK] }, 'unverified', 'status-basis-missing'],
  ['rule without status does not confirm', { declared: 'confirmed_policy', rawDeclared: '확정', rule: { match: 'a', basis: '운영자' } }, 'unverified', 'status-basis-missing'],
  ['blank rule basis does not confirm', { rule: rule('confirmed_policy', '  ') }, 'unverified', 'status-basis-missing'],
  ['rule for another status does not confirm', { declared: 'confirmed_policy', rawDeclared: '확정', rule: rule('verified_experience') }, 'unverified', 'status-basis-missing'],
];

describe('resolveBaseStatus', () => {
  for (const [name, overrides, status, reason] of TABLE) {
    it(name, () => {
      const result = resolveBaseStatus({ declared: null, rawDeclared: null, basis: [], rule: null, codeLinks: [], ...overrides });
      assert.deepEqual([result.status, result.reason], [status, reason]);
    });
  }

  it('records how each outcome was established', () => {
    const base: StatusInput = { declared: 'confirmed_policy', rawDeclared: '확정', basis: [PATH_OK], rule: null, codeLinks: [] };
    assert.deepEqual(resolveBaseStatus(base).basis, { kind: 'refs', resolution: 'resolved', refs: [PATH_OK] });
    assert.deepEqual(resolveBaseStatus({ ...base, declared: 'deprecated' }).basis, { kind: 'declared' });
    assert.deepEqual(resolveBaseStatus({ ...base, basis: [], rule: rule('confirmed_policy', '운영자 확인') }).basis, {
      kind: 'source-rule',
      value: '운영자 확인',
      rule: 'doc/*.md',
      resolution: 'operator-declared',
    });
    assert.deepEqual(resolveBaseStatus({ ...base, basis: [PATH_BAD] }).basis, { kind: 'none', resolution: 'unresolved', refs: [PATH_BAD] });
  });
});

interface Doc {
  path: string;
  text: string;
  source?: string;
  project?: string;
  rule?: SourceRule;
  defaultKind?: Kind;
}

const COMMIT = 'abcdef1234567';
const FACTS: SourceFacts = { tracked: new Set(['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/ref.md', 'src/a.ts']), existingCommits: new Set([COMMIT]) };

function resolveDocs(docs: Doc[]): Map<string, ResolvedItem & { itemId: string }> {
  let itemPk = 0;
  const items = docs.flatMap((doc, documentPk): GenerationItem[] => {
    const sourceId = doc.source ?? 's';
    const projectId = doc.project ?? 'p';
    const built = buildDocumentItems({ sourceId, projectId, path: doc.path, text: doc.text, rule: doc.rule ?? null, defaultKind: doc.defaultKind ?? 'reference' });
    return built.items.map((item) => ({
      itemPk: ++itemPk,
      itemId: item.itemId,
      documentPk,
      sourceId,
      projectId,
      path: doc.path,
      ordinal: item.ordinal,
      key: item.key,
      anchor: item.anchor,
      kind: item.kind,
      declaredStatus: item.declaredStatus,
      declaredStatusRaw: item.declaredStatusRaw,
      basisRefs: item.basisRefs,
      rule: item.rule,
      relations: item.relations,
    }));
  });
  const sources = new Map(docs.map((doc) => [doc.source ?? 's', FACTS]));
  const resolved = resolveGeneration(items, sources);
  // 앵커는 문서 안에서 유일하므로 같은 키가 반복돼도 항목이 겹치지 않는다
  return new Map(items.map((item, index) => [`${item.projectId}:${item.path}:${item.anchor}`, { ...resolved[index]!, itemId: item.itemId }]));
}

function entry(key: string, ...fields: string[]): string {
  return [`### \`${key}\` ${key} 제목`, ...fields.map((field) => `- ${field}`), '', '본문입니다.', ''].join('\n');
}

function doc(...entries: string[]): string {
  return ['# 문서', '', ...entries].join('\n');
}

const CONFIRMED = ['상태: 확정', '근거: docs/ref.md'];

function one(results: Map<string, ResolvedItem & { itemId: string }>, key: string): ResolvedItem & { itemId: string } {
  const found = results.get(key);
  assert.ok(found, `missing ${key}; have ${[...results.keys()].join(', ')}`);
  return found;
}

function brief(item: ResolvedItem): [string, string, string] {
  return [item.baseStatus, item.effectiveStatus, item.reason];
}

describe('basis resolution', () => {
  it('accepts a tracked path but not the own document or an untracked path', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('OK', '상태: 확정', '근거: `docs/b.md`'), entry('OWN', '상태: 확정', '근거: docs/a.md'), entry('ANCHOR', '상태: 확정', '근거: path:docs/ref.md#절'), entry('NONE', '상태: 확정', '근거: docs/missing.md')) },
    ]);
    assert.equal(one(results, 'p:docs/a.md:OK').baseStatus, 'confirmed_policy');
    assert.deepEqual(brief(one(results, 'p:docs/a.md:OWN')), ['unverified', 'unverified', 'status-basis-unresolved']);
    assert.equal(one(results, 'p:docs/a.md:ANCHOR').baseStatus, 'confirmed_policy');
    assert.deepEqual(brief(one(results, 'p:docs/a.md:NONE')), ['unverified', 'unverified', 'status-basis-unresolved']);
  });

  it('accepts only commits that exist and never verify or opaque references', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('C1', '상태: 검증됨', `근거: commit:${COMMIT}`), entry('C2', '상태: 검증됨', '근거: commit:fffffff'), entry('V', '상태: 검증됨', '근거: verify:test'), entry('O', '상태: 확정', '근거: 회의에서 합의함')) },
    ]);
    assert.equal(one(results, 'p:docs/a.md:C1').baseStatus, 'verified_experience');
    for (const key of ['C2', 'V', 'O']) assert.deepEqual(brief(one(results, `p:docs/a.md:${key}`)), ['unverified', 'unverified', 'status-basis-unresolved'], key);
  });

  it('treats an observation with a tracked code link as observed, and an untracked one as unverified', () => {
    const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('OK', '상태: 관찰', '코드: src/a.ts:12'), entry('NO', '상태: 관찰', '코드: src/none.ts')) }]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:OK')), ['observed_behavior', 'observed_behavior', 'code-reference-resolved']);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:NO')), ['unverified', 'unverified', 'observation-without-code-reference']);
  });

  it('maps `확정 예정` to unknown with a diagnostic and never confirms it', () => {
    const text = doc(entry('X', '상태: 확정 예정', '근거: docs/ref.md'));
    assert.deepEqual(buildDocumentItems({ sourceId: 's', projectId: 'p', path: 'docs/a.md', text }).diagnostics.map((item) => item.code), ['unknown-status-value']);
    assert.deepEqual(brief(one(resolveDocs([{ path: 'docs/a.md', text }]), 'p:docs/a.md:X')), ['unverified', 'unverified', 'unknown-status-value']);
  });

  it('does not let a two-item cycle confirm itself', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: item:B')) },
      { path: 'docs/b.md', text: doc(entry('B', '상태: 확정', '근거: item:A')) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ['unverified', 'unverified', 'status-basis-unresolved']);
    assert.deepEqual(brief(one(results, 'p:docs/b.md:B')), ['unverified', 'unverified', 'status-basis-unresolved']);
  });

  it('does not count an item basis pointing at an unverified item', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: item:B')) },
      { path: 'docs/b.md', text: doc(entry('B', '상태: 미확인')) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ['unverified', 'unverified', 'status-basis-unresolved']);
  });

  it('counts an item basis to a pass-1 confirmed item in another document', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 검증됨', '근거: item:B')) },
      { path: 'docs/b.md', text: doc(entry('B', ...CONFIRMED)) },
    ]);
    const a = one(results, 'p:docs/a.md:A');
    assert.deepEqual(brief(a), ['verified_experience', 'verified_experience', 'basis-resolved']);
    assert.deepEqual(a.basis, { kind: 'refs', resolution: 'resolved', refs: [{ kind: 'item', value: 'B', resolved: true, targetItemId: 's:docs/b.md#B' }] });
  });

  it('rejects an item basis in the same document', () => {
    const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: item:B'), entry('B', ...CONFIRMED)) }]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ['unverified', 'unverified', 'status-basis-unresolved']);
    assert.equal(one(results, 'p:docs/a.md:B').baseStatus, 'confirmed_policy');
  });

  it('does not accept a retired document that has no section as a basis', () => {
    for (const body of [['---', 'status: 폐기', 'title: 옛 문서', '---'], ['---', 'status: 폐기', '---', '## 제목만']]) {
      const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: docs/b.md')) }, { path: 'docs/b.md', text: body.join('\n') }]);
      assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ['unverified', 'unverified', 'status-basis-unresolved']);
      assert.equal(one(results, 'p:docs/b.md:_intro').baseStatus, 'deprecated');
    }
  });

  it('resolves references to the frontmatter id of a document without a section', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: item:POL-9', '연결: POL-9')) },
      { path: 'docs/b.md', text: ['---', 'id: POL-9', 'status: 확정', 'status_basis: docs/ref.md', '---'].join('\n') },
    ]);
    const a = one(results, 'p:docs/a.md:A');
    assert.deepEqual(brief(a), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
    assert.deepEqual(a.basis, { kind: 'refs', resolution: 'resolved', refs: [{ kind: 'item', value: 'POL-9', resolved: true, targetItemId: 's:docs/b.md#_intro' }] });
  });

  it('never chains item bases: only pass-1 status of the target counts', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: item:B')) },
      { path: 'docs/b.md', text: doc(entry('B', '상태: 확정', '근거: item:C')) },
      { path: 'docs/c.md', text: doc(entry('C', ...CONFIRMED)) },
    ]);
    assert.equal(one(results, 'p:docs/b.md:B').baseStatus, 'confirmed_policy');
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ['unverified', 'unverified', 'status-basis-unresolved']);
  });

  it('does not count a basis pointing at an observed item or an ambiguous key', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: item:OBS'), entry('B', '상태: 확정', '근거: item:DUP')) },
      { path: 'docs/b.md', text: doc(entry('OBS', '상태: 관찰', '코드: src/a.ts'), entry('DUP', ...CONFIRMED)) },
      { path: 'docs/c.md', text: doc(entry('DUP', ...CONFIRMED)) },
    ]);
    assert.equal(one(results, 'p:docs/a.md:A').baseStatus, 'unverified');
    assert.equal(one(results, 'p:docs/a.md:B').baseStatus, 'unverified');
  });

  it('lets an observation rest on a confirmed item in pass 2', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 관찰', '근거: item:B')) },
      { path: 'docs/b.md', text: doc(entry('B', ...CONFIRMED)) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ['observed_behavior', 'observed_behavior', 'basis-resolved']);
  });

  it('resolves project-qualified targets and does not fall back across projects', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', project: 'one', text: doc(entry('A', '상태: 확정', '근거: item:two:B'), entry('U', '상태: 확정', '근거: item:B')) },
      { path: 'docs/b.md', project: 'two', source: 't', text: doc(entry('B', ...CONFIRMED)) },
    ]);
    assert.equal(one(results, 'one:docs/a.md:A').baseStatus, 'confirmed_policy');
    assert.equal(one(results, 'one:docs/a.md:U').baseStatus, 'unverified');
  });
});

describe('conflict overlay', () => {
  it('flags both sides of a declared conflict and keeps the base status', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', ...CONFIRMED, '충돌: `B`')) },
      { path: 'docs/b.md', text: doc(entry('B', ...CONFIRMED)) },
    ]);
    const a = one(results, 'p:docs/a.md:A');
    const b = one(results, 'p:docs/b.md:B');
    assert.deepEqual(brief(a), ['confirmed_policy', 'conflicted', 'basis-resolved']);
    assert.deepEqual(a.conflicts, [{ reason: 'declared', withItemIds: ['s:docs/b.md#B'], target: 'B' }]);
    assert.equal(b.effectiveStatus, 'conflicted');
    assert.equal(b.baseStatus, 'confirmed_policy');
    assert.deepEqual(b.conflicts, [{ reason: 'declared', withItemIds: ['s:docs/a.md#A'] }]);
  });

  it('does not double a mutual declaration', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '충돌: `B`')) },
      { path: 'docs/b.md', text: doc(entry('B', '충돌: `A`')) },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:A').conflicts, [{ reason: 'declared', withItemIds: ['s:docs/b.md#B'], target: 'B' }]);
    assert.deepEqual(one(results, 'p:docs/b.md:B').conflicts, [{ reason: 'declared', withItemIds: ['s:docs/a.md#A'], target: 'A' }]);
  });

  it('flags only the declarer when the target is unresolved or ambiguous', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', ...CONFIRMED, '충돌: `NOPE`'), entry('B', ...CONFIRMED, '충돌: `DUP`')) },
      { path: 'docs/b.md', text: doc(entry('DUP', '상태: 폐기')) },
      { path: 'docs/c.md', text: doc(entry('DUP', '상태: 폐기')) },
    ]);
    const a = one(results, 'p:docs/a.md:A');
    assert.equal(a.effectiveStatus, 'conflicted');
    assert.deepEqual(a.conflicts, [{ reason: 'declared', withItemIds: [], target: 'NOPE' }]);
    const b = one(results, 'p:docs/a.md:B');
    assert.deepEqual(b.conflicts, [{ reason: 'declared', withItemIds: [], target: 'DUP' }]);
    const link = b.links.find((item) => item.relation === 'conflicts_with')!;
    assert.deepEqual(link, { relation: 'conflicts_with', target: 'DUP', resolved: false, kind: 'item', ambiguous: true, candidates: ['s:docs/b.md#DUP', 's:docs/c.md#DUP'] });
  });

  it('ignores a deprecated target and a deprecated declarer entirely', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('LIVE', ...CONFIRMED, '충돌: `OLD`')) },
      { path: 'docs/b.md', text: doc(entry('OLD', '상태: 폐기', '충돌: `OTHER`')) },
      { path: 'docs/c.md', text: doc(entry('OTHER', ...CONFIRMED)) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:LIVE')), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
    assert.deepEqual(one(results, 'p:docs/a.md:LIVE').conflicts, []);
    assert.deepEqual(brief(one(results, 'p:docs/b.md:OLD')), ['deprecated', 'deprecated', 'declared-deprecated']);
    assert.deepEqual(one(results, 'p:docs/b.md:OLD').conflicts, []);
    assert.deepEqual(one(results, 'p:docs/c.md:OTHER').conflicts, []);
  });

  it('flags a duplicate key in one project, in the same or different documents', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('BR-1', ...CONFIRMED), entry('BR-1', ...CONFIRMED)) },
      { path: 'docs/b.md', text: doc(entry('BR-1', '상태: 미확인')) },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:BR-1').conflicts, [{ reason: 'duplicate-key', withItemIds: ['s:docs/a.md#BR-1-1', 's:docs/b.md#BR-1'] }]);
    assert.deepEqual(one(results, 'p:docs/a.md:BR-1-1').conflicts, [{ reason: 'duplicate-key', withItemIds: ['s:docs/a.md#BR-1', 's:docs/b.md#BR-1'] }]);
    const third = one(results, 'p:docs/b.md:BR-1');
    assert.equal(third.baseStatus, 'unverified');
    assert.equal(third.effectiveStatus, 'conflicted');
  });

  it('allows the same key in different projects unless both own a contract', () => {
    const shared = doc(entry('CON-1', ...CONFIRMED, '종류: contract'));
    const plain = doc(entry('BR-1', ...CONFIRMED));
    const contracts = resolveDocs([
      { path: 'docs/a.md', project: 'one', text: shared },
      { path: 'docs/a.md', project: 'two', source: 't', text: shared },
    ]);
    assert.deepEqual(one(contracts, 'one:docs/a.md:CON-1').conflicts, [{ reason: 'duplicate-contract-owner', withItemIds: ['t:docs/a.md#CON-1'] }]);
    assert.equal(one(contracts, 'two:docs/a.md:CON-1').effectiveStatus, 'conflicted');

    const others = resolveDocs([
      { path: 'docs/a.md', project: 'one', text: plain },
      { path: 'docs/a.md', project: 'two', source: 't', text: plain },
    ]);
    assert.equal(one(others, 'one:docs/a.md:BR-1').effectiveStatus, 'confirmed_policy');
  });

  it('keeps a deprecated same-key item out of conflicts and the live item confirmed', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('BR-1', '상태: 폐기')) },
      { path: 'docs/b.md', text: doc(entry('BR-1', ...CONFIRMED)) },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:BR-1').conflicts, []);
    assert.equal(one(results, 'p:docs/a.md:BR-1').effectiveStatus, 'deprecated');
    assert.deepEqual(one(results, 'p:docs/b.md:BR-1').conflicts, []);
    assert.deepEqual(brief(one(results, 'p:docs/b.md:BR-1')), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
  });

  it('exempts duplicate pairs connected by a resolved supersedes link', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('BR-1', ...CONFIRMED)) },
      { path: 'docs/b.md', text: doc(entry('BR-1', ...CONFIRMED, '대체: `docs/a.md#BR-1`')) },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:BR-1').conflicts, []);
    assert.deepEqual(one(results, 'p:docs/b.md:BR-1').conflicts, []);
  });

  it('does not exempt a third item from the supersedes pair', () => {
    // 대체자가 확정이면 대상이 폐기되어 중복 판정에서 빠지므로, 쌍이 살아 있도록 둘 다 미확인으로 둔다
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('BR-1', '상태: 미확인')) },
      { path: 'docs/b.md', text: doc(entry('BR-1', '상태: 미확인', '대체: `docs/a.md#BR-1`')) },
      { path: 'docs/c.md', text: doc(entry('BR-1', ...CONFIRMED)) },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:BR-1').conflicts, [{ reason: 'duplicate-key', withItemIds: ['s:docs/c.md#BR-1'] }]);
    assert.deepEqual(one(results, 'p:docs/c.md:BR-1').conflicts, [{ reason: 'duplicate-key', withItemIds: ['s:docs/a.md#BR-1', 's:docs/b.md#BR-1'] }]);
  });

  it('does not let a supersedes from another project silence the contract owner conflict', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', project: 'one', text: doc(entry('CON-1', ...CONFIRMED, '종류: contract', '대체: `two:docs/b.md#CON-1`')) },
      { path: 'docs/b.md', project: 'two', source: 't', text: doc(entry('CON-1', ...CONFIRMED, '종류: contract')) },
    ]);
    assert.deepEqual(one(results, 'one:docs/a.md:CON-1').conflicts, [{ reason: 'duplicate-contract-owner', withItemIds: ['t:docs/b.md#CON-1'] }]);
    assert.deepEqual(one(results, 'two:docs/b.md:CON-1').conflicts, [{ reason: 'duplicate-contract-owner', withItemIds: ['s:docs/a.md#CON-1'] }]);
    // 다른 프로젝트의 항목을 폐기시키지도 못한다
    assert.deepEqual(brief(one(results, 'two:docs/b.md:CON-1')), ['confirmed_policy', 'conflicted', 'basis-resolved']);
  });

  it('does not let an item conflict with itself', () => {
    const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('A', ...CONFIRMED, '충돌: `A`')) }]);
    const a = one(results, 'p:docs/a.md:A');
    assert.deepEqual(brief(a), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
    assert.deepEqual(a.conflicts, []);
    assert.equal(a.links.find((link) => link.relation === 'conflicts_with')?.targetItemId, 's:docs/a.md#A');
  });

  it('drops only the self reference from a conflict inherited from a section', () => {
    const text = ['# 문서', '', '## 묶음', '', '- 상태: 확정', '- 근거: docs/ref.md', '- 충돌: `BR-2`', '', '본문입니다.', '', entry('BR-1', ...CONFIRMED), entry('BR-2', ...CONFIRMED)].join('\n');
    const results = resolveDocs([{ path: 'docs/a.md', text }]);
    assert.deepEqual(one(results, 'p:docs/a.md:BR-2').conflicts, [
      { reason: 'declared', withItemIds: ['s:docs/a.md#BR-1'] },
      { reason: 'declared', withItemIds: ['s:docs/a.md#묶음'] },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:BR-1').conflicts, [{ reason: 'declared', withItemIds: ['s:docs/a.md#BR-2'], target: 'BR-2' }]);
  });
});

describe('path basis targets', () => {
  const REJECTED = ['unverified', 'unverified', 'status-basis-unresolved'];
  const ACCEPTED = ['confirmed_policy', 'confirmed_policy', 'basis-resolved'];
  const citing = (basis: string, targetText: string): [string, string, string] =>
    brief(one(resolveDocs([{ path: 'docs/a.md', text: doc(entry('X', '상태: 확정', `근거: ${basis}`)) }, { path: 'docs/b.md', text: targetText }]), 'p:docs/a.md:X'));

  it('rejects a basis anchored to a deprecated or unverified item', () => {
    const target = doc(entry('GONE', '상태: 폐기'), entry('GUESS', '상태: 미확인'), entry('LIVE', ...CONFIRMED), entry('PLAIN'));
    assert.deepEqual(citing('path:docs/b.md#GONE', target), REJECTED);
    assert.deepEqual(citing('path:docs/b.md#GUESS', target), REJECTED);
    assert.deepEqual(citing('path:docs/b.md#LIVE', target), ACCEPTED);
    assert.deepEqual(citing('path:docs/b.md#PLAIN', target), ACCEPTED);
  });

  it('finds an anchored section by its heading slug', () => {
    const target = ['# 문서', '', '## 낡은 절', '', '- 상태: 폐기', '', '본문이다.', '', '## 현행 절', '', '본문이다.', ''].join('\n');
    assert.deepEqual(citing('path:docs/b.md#낡은-절', target), REJECTED);
    assert.deepEqual(citing('docs/b.md#현행-절', target), ACCEPTED);
  });

  it('rejects an unanchored basis only when every item of the target is deprecated or unverified', () => {
    assert.deepEqual(citing('docs/b.md', doc(entry('GONE', '상태: 폐기'), entry('GUESS', '상태: 미확인'))), REJECTED);
    assert.deepEqual(citing('docs/b.md', doc(entry('GONE', '상태: 폐기'), entry('LIVE', ...CONFIRMED))), ACCEPTED);
    assert.deepEqual(citing('docs/b.md', doc(entry('GONE', '상태: 폐기'), entry('PLAIN'))), ACCEPTED);
  });

  it('sees a status declared for the whole document', () => {
    assert.deepEqual(citing('docs/b.md', '---\nstatus: 폐기\n---\n# 문서\n\n본문이다.\n'), REJECTED);
    assert.deepEqual(citing('docs/b.md', '---\nstatus: 미확인\n---\n# 문서\n\n본문이다.\n'), REJECTED);
  });

  it('keeps a document with no declared status as a valid basis', () => {
    assert.deepEqual(citing('docs/b.md', '# 문서\n\n본문이다.\n'), ACCEPTED);
  });

  it('does not accept a target whose status value is not in the vocabulary', () => {
    assert.deepEqual(citing('docs/b.md', doc(entry('MAYBE', '상태: 확정 예정'))), REJECTED);
    assert.deepEqual(citing('path:docs/b.md#MAYBE', doc(entry('MAYBE', '상태: 초안'), entry('LIVE', ...CONFIRMED))), REJECTED);
  });

  it('judges the whole document when the anchor names no item', () => {
    assert.deepEqual(citing('path:docs/b.md#없는-절', doc(entry('GONE', '상태: 폐기'))), REJECTED);
    assert.deepEqual(citing('path:docs/b.md#없는-절', doc(entry('LIVE', ...CONFIRMED))), ACCEPTED);
  });

  it('rejects two documents citing each other', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: docs/b.md')) },
      { path: 'docs/b.md', text: doc(entry('B', '상태: 확정', '근거: docs/a.md')) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), REJECTED);
    assert.deepEqual(brief(one(results, 'p:docs/b.md:B')), REJECTED);
  });

  it('rejects an indirect cycle but not a document that only cites into it', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: docs/b.md')) },
      { path: 'docs/b.md', text: doc(entry('B', '상태: 확정', '근거: docs/c.md')) },
      { path: 'docs/c.md', text: doc(entry('C', '상태: 확정', '근거: docs/a.md')) },
      { path: 'docs/ref.md', text: doc(entry('OUT', '상태: 확정', '근거: docs/a.md')) },
    ]);
    for (const [path, key] of [['a', 'A'], ['b', 'B'], ['c', 'C']]) assert.deepEqual(brief(one(results, `p:docs/${path}.md:${key}`)), REJECTED, key);
    assert.deepEqual(brief(one(results, 'p:docs/ref.md:OUT')), ACCEPTED);
  });

  it('counts a citation from any item of the document, stated status or not', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: docs/b.md')) },
      { path: 'docs/b.md', text: doc(entry('NOTE', '근거: docs/a.md')) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), REJECTED);
  });

  it('has no citation edge for a tracked file that is not indexed', () => {
    const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: src/a.ts')) }]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ACCEPTED);
  });

  it('looks the target up in the source of the citing item only', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: docs/b.md')) },
      { path: 'docs/b.md', project: 'two', source: 't', text: doc(entry('GONE', '상태: 폐기', '근거: docs/a.md')) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ACCEPTED);
  });

  const RETIRED_BY_RULE: SourceRule = { match: 'docs/b.md', status: 'deprecated' };
  const replacing = (key: string): Doc => ({ path: 'docs/c.md', text: doc(entry('NEW', ...CONFIRMED, `대체: \`${key}\``)) });

  it('rejects a target retired by a source rule, whatever the target declares', () => {
    for (const text of ['# 문서\n\n본문이다.\n', doc(entry('B', ...CONFIRMED))]) {
      const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('X', '상태: 확정', '근거: docs/b.md')) }, { path: 'docs/b.md', text, rule: RETIRED_BY_RULE }]);
      assert.deepEqual(brief(one(results, 'p:docs/a.md:X')), REJECTED, text);
    }
  });

  it('rejects a target retired by a replacement, anchored or not', () => {
    for (const basis of ['docs/b.md', 'path:docs/b.md#B']) {
      const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('X', '상태: 확정', `근거: ${basis}`)) }, { path: 'docs/b.md', text: doc(entry('B', ...CONFIRMED)) }, replacing('B')]);
      assert.deepEqual(brief(one(results, 'p:docs/a.md:X')), REJECTED, basis);
    }
  });

  it('rejects a target in conflict, anchored or not', () => {
    const conflicted = doc(entry('B', ...CONFIRMED, '충돌: `NOPE`'));
    assert.deepEqual(citing('docs/b.md', conflicted), REJECTED);
    assert.deepEqual(citing('path:docs/b.md#B', conflicted), REJECTED);
  });

  it('keeps an unanchored basis while any item of the target can back it', () => {
    const target = doc(entry('B', ...CONFIRMED), entry('PLAIN'));
    const cited = (basis: string): [string, string, string] => brief(one(resolveDocs([{ path: 'docs/a.md', text: doc(entry('X', '상태: 확정', `근거: ${basis}`)) }, { path: 'docs/b.md', text: target }, replacing('B')]), 'p:docs/a.md:X'));
    assert.deepEqual(cited('docs/b.md'), ACCEPTED);
    assert.deepEqual(cited('path:docs/b.md#B'), REJECTED);
  });

  it('re-judges every basis of an item confirmed in pass 1', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('X', '상태: 확정', '근거: docs/b.md item:docs/ref.md#E')) },
      { path: 'docs/b.md', text: doc(entry('B', ...CONFIRMED)), rule: RETIRED_BY_RULE },
      { path: 'docs/ref.md', text: doc(entry('E', '상태: 확정', '근거: src/a.ts')) },
    ]);
    const x = one(results, 'p:docs/a.md:X');
    assert.deepEqual(brief(x), ACCEPTED);
    assert.deepEqual(x.basis.refs?.map((ref) => [ref.kind, ref.resolved]), [['path', false], ['item', true]]);
  });

  it('does not let an item basis rest on a target whose path basis was withdrawn', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('X', '상태: 확정', '근거: item:docs/c.md#MID')) },
      { path: 'docs/b.md', text: doc(entry('B', ...CONFIRMED)), rule: RETIRED_BY_RULE },
      { path: 'docs/c.md', text: doc(entry('MID', '상태: 확정', '근거: docs/b.md')) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/c.md:MID')), REJECTED);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:X')), REJECTED);
  });

  it('adds no citation edge for a retired item', () => {
    const cited = (b: Doc): [string, string, string] => brief(one(resolveDocs([{ path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: docs/b.md#LIVE'), entry('NOTE')) }, b]), 'p:docs/a.md:A'));
    assert.deepEqual(cited({ path: 'docs/b.md', text: doc(entry('LIVE'), entry('OLD', '상태: 폐기', '근거: docs/a.md#NOTE')) }), ACCEPTED);
    assert.deepEqual(cited({ path: 'docs/b.md', text: doc(entry('LIVE', '근거: docs/a.md#NOTE')), rule: RETIRED_BY_RULE }), REJECTED, 'the rule retires the anchored target itself');
  });

  it('drops the citation of a rule-retired item from the graph', () => {
    // 폐기 규칙이 걸린 b.md의 인용이 없으면 a → c → b에서 되돌아오는 길이 없다
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: docs/c.md')) },
      { path: 'docs/b.md', text: doc(entry('GONE', '근거: docs/a.md')), rule: RETIRED_BY_RULE },
      { path: 'docs/c.md', text: doc(entry('LIVE', '근거: docs/b.md')) },
    ]);
    assert.equal(one(results, 'p:docs/b.md:GONE').baseStatus, 'deprecated');
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ACCEPTED);
  });

  it('keeps the citation of an item the rule could not retire', () => {
    // 작성자가 관찰로 표시한 항목은 폐기 규칙이 덮지 못하므로 살아 있고, 그 인용은 순환을 만든다
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: docs/b.md')) },
      { path: 'docs/b.md', text: doc(entry('OBS', '상태: 관찰', '코드: src/a.ts', '근거: docs/a.md')), rule: RETIRED_BY_RULE },
    ]);
    assert.equal(one(results, 'p:docs/b.md:OBS').baseStatus, 'observed_behavior');
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), REJECTED);
  });
});

describe('item basis targets', () => {
  const REJECTED = ['unverified', 'unverified', 'status-basis-unresolved'];
  const citing = (...entries: [path: string, text: string][]): [string, string, string] =>
    brief(one(resolveDocs([{ path: 'docs/a.md', text: doc(entry('A', '상태: 확정', '근거: item:docs/b.md#B')) }, ...entries.map(([path, text]) => ({ path, text }))]), 'p:docs/a.md:A'));

  it('rejects a target in a declared conflict', () => {
    assert.deepEqual(citing(['docs/b.md', doc(entry('B', ...CONFIRMED, '충돌: `C`'))], ['docs/c.md', doc(entry('C', ...CONFIRMED))]), REJECTED);
  });

  it('rejects a target named as the other side of a conflict', () => {
    assert.deepEqual(citing(['docs/b.md', doc(entry('B', ...CONFIRMED))], ['docs/c.md', doc(entry('C', ...CONFIRMED, '충돌: `B`'))]), REJECTED);
  });

  it('rejects a target in a duplicate key conflict', () => {
    assert.deepEqual(citing(['docs/b.md', doc(entry('B', ...CONFIRMED))], ['docs/c.md', doc(entry('B', ...CONFIRMED))]), REJECTED);
  });

  it('rejects a superseded target', () => {
    assert.deepEqual(citing(['docs/b.md', doc(entry('B', ...CONFIRMED))], ['docs/c.md', doc(entry('C', ...CONFIRMED, '대체: `B`'))]), REJECTED);
  });

  it('rejects a target replaced by an unconfirmed item', () => {
    assert.deepEqual(citing(['docs/b.md', doc(entry('B', ...CONFIRMED))], ['docs/c.md', doc(entry('C', '상태: 미확인', '대체: `B`'))]), REJECTED);
  });

  it('rejects a target that is retired only once its replacement passes the item basis pass', () => {
    const replacement = doc(entry('C', '상태: 확정', '근거: item:docs/ref.md#R', '대체: `B`'));
    assert.deepEqual(citing(['docs/b.md', doc(entry('B', ...CONFIRMED))], ['docs/c.md', replacement], ['docs/ref.md', doc(entry('R', '상태: 확정', '근거: src/a.ts'))]), REJECTED);
  });
});

describe('supersession', () => {
  const NEW_ID = 's:docs/b.md#NEW';
  const pair = (replacing: string[], replaced: string[]): Map<string, ResolvedItem & { itemId: string }> =>
    resolveDocs([
      { path: 'docs/a.md', text: doc(entry('OLD', ...replaced)) },
      { path: 'docs/b.md', text: doc(entry('NEW', ...replacing, '대체: `OLD`')) },
    ]);

  it('retires the target of a confirmed replacement and records the replacement as the basis', () => {
    const results = pair(CONFIRMED, CONFIRMED);
    const old = one(results, 'p:docs/a.md:OLD');
    assert.deepEqual(brief(old), ['deprecated', 'deprecated', 'superseded']);
    assert.deepEqual(old.basis, { kind: 'refs', resolution: 'resolved', refs: [{ kind: 'item', value: NEW_ID, resolved: true, targetItemId: NEW_ID }] });
    assert.deepEqual(old.conflicts, []);
    assert.deepEqual(brief(one(results, 'p:docs/b.md:NEW')), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
  });

  it('retires a target of any status when the replacement is verified', () => {
    assert.deepEqual(brief(one(pair(['상태: 검증됨', '근거: docs/ref.md'], ['상태: 미확인']), 'p:docs/a.md:OLD')), ['deprecated', 'deprecated', 'superseded']);
  });

  for (const [name, replacing] of [['unverified', ['상태: 미확인']], ['observed', ['상태: 관찰', '코드: src/a.ts']], ['undeclared', []]] as [string, string[]][]) {
    it(`flags a confirmed target replaced by an ${name} item instead of retiring it`, () => {
      const old = one(pair(replacing, CONFIRMED), 'p:docs/a.md:OLD');
      assert.deepEqual(brief(old), ['confirmed_policy', 'conflicted', 'basis-resolved']);
      assert.deepEqual(old.conflicts, [{ reason: 'unconfirmed-supersession', withItemIds: [NEW_ID] }]);
    });
  }

  it('leaves an unconfirmed target alone when the replacement is unconfirmed too', () => {
    const old = one(pair(['상태: 미확인'], ['상태: 미확인']), 'p:docs/a.md:OLD');
    assert.deepEqual(brief(old), ['unverified', 'unverified', 'declared']);
    assert.deepEqual(old.conflicts, []);
  });

  it('does nothing when the replacement itself is deprecated', () => {
    const old = one(pair(['상태: 폐기'], CONFIRMED), 'p:docs/a.md:OLD');
    assert.deepEqual(brief(old), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
    assert.deepEqual(old.conflicts, []);
  });

  it('skips a mutual pair and keeps its duplicate key conflict', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('BR-1', ...CONFIRMED, '대체: `docs/b.md#BR-1`')) },
      { path: 'docs/b.md', text: doc(entry('BR-1', ...CONFIRMED, '대체: `docs/a.md#BR-1`')) },
    ]);
    for (const [path, other] of [['docs/a.md', 's:docs/b.md#BR-1'], ['docs/b.md', 's:docs/a.md#BR-1']] as const) {
      const item = one(results, `p:${path}:BR-1`);
      assert.deepEqual(brief(item), ['confirmed_policy', 'conflicted', 'basis-resolved'], path);
      assert.deepEqual(item.conflicts, [{ reason: 'duplicate-key', withItemIds: [other] }], path);
    }
  });

  it('skips an item that names itself', () => {
    const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('A', ...CONFIRMED, '대체: `A`')) }]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:A')), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
  });

  it('retires every link of a chain regardless of order', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', ...CONFIRMED, '대체: `B`')) },
      { path: 'docs/b.md', text: doc(entry('B', ...CONFIRMED, '대체: `C`')) },
      { path: 'docs/c.md', text: doc(entry('C', ...CONFIRMED)) },
    ]);
    assert.equal(one(results, 'p:docs/a.md:A').effectiveStatus, 'confirmed_policy');
    assert.deepEqual(brief(one(results, 'p:docs/b.md:B')), ['deprecated', 'deprecated', 'superseded']);
    assert.deepEqual(brief(one(results, 'p:docs/c.md:C')), ['deprecated', 'deprecated', 'superseded']);
  });

  it('uses the status settled by the item basis pass', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('NEW', '상태: 확정', '근거: item:EVIDENCE', '대체: `OLD`')) },
      { path: 'docs/b.md', text: doc(entry('OLD', ...CONFIRMED)) },
      { path: 'docs/c.md', text: doc(entry('EVIDENCE', ...CONFIRMED)) },
    ]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:NEW')), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
    assert.deepEqual(brief(one(results, 'p:docs/b.md:OLD')), ['deprecated', 'deprecated', 'superseded']);
  });

  it('lists every confirmed replacement once, in order', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('OLD', ...CONFIRMED)) },
      { path: 'docs/c.md', text: doc(entry('Z', ...CONFIRMED, '대체: `OLD` `docs/a.md#OLD`')) },
      { path: 'docs/b.md', text: doc(entry('Y', ...CONFIRMED, '대체: `OLD`')) },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:OLD').basis.refs?.map((ref) => ref.targetItemId), ['s:docs/b.md#Y', 's:docs/c.md#Z']);
  });

  it('reports one conflict per unconfirmed replacement however it is spelled', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('OLD', ...CONFIRMED)) },
      { path: 'docs/b.md', text: doc(entry('NEW', '상태: 미확인', '대체: `OLD` `docs/a.md#OLD`')) },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:OLD').conflicts, [{ reason: 'unconfirmed-supersession', withItemIds: [NEW_ID] }]);
  });

  it('does not retire an item in another project', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', project: 'one', text: doc(entry('OLD', ...CONFIRMED)) },
      { path: 'docs/b.md', project: 'two', source: 't', text: doc(entry('NEW', ...CONFIRMED, '대체: `one:OLD`')) },
    ]);
    assert.deepEqual(brief(one(results, 'one:docs/a.md:OLD')), ['confirmed_policy', 'confirmed_policy', 'basis-resolved']);
  });

  const CONFIRMED_BRIEF = ['confirmed_policy', 'confirmed_policy', 'basis-resolved'];

  it('skips every link of a replacement cycle, however long', () => {
    for (const keys of [['A', 'B', 'C'], ['A', 'B', 'C', 'D']]) {
      const results = resolveDocs(keys.map((key, index) => ({ path: `docs/${key}.md`, text: doc(entry(key, ...CONFIRMED, `대체: \`${keys[(index + 1) % keys.length]}\``)) })));
      for (const key of keys) assert.deepEqual(brief(one(results, `p:docs/${key}.md:${key}`)), CONFIRMED_BRIEF, key);
    }
  });

  it('still retires an item outside the cycle that a cycle member replaces', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A', ...CONFIRMED, '대체: `B` `OUT`')) },
      { path: 'docs/b.md', text: doc(entry('B', ...CONFIRMED, '대체: `C`')) },
      { path: 'docs/c.md', text: doc(entry('C', ...CONFIRMED, '대체: `A`')) },
      { path: 'docs/out.md', text: doc(entry('OUT', ...CONFIRMED)) },
    ]);
    for (const [path, key] of [['a', 'A'], ['b', 'B'], ['c', 'C']]) assert.deepEqual(brief(one(results, `p:docs/${path}.md:${key}`)), CONFIRMED_BRIEF, key);
    assert.deepEqual(brief(one(results, 'p:docs/out.md:OUT')), ['deprecated', 'deprecated', 'superseded']);
  });

  it('keeps the duplicate key conflict across a replacement cycle', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('DUP', ...CONFIRMED, '대체: `docs/b.md#DUP`')) },
      { path: 'docs/b.md', text: doc(entry('DUP', ...CONFIRMED, '대체: `docs/c.md#DUP`')) },
      { path: 'docs/c.md', text: doc(entry('DUP', ...CONFIRMED, '대체: `docs/a.md#DUP`')) },
    ]);
    assert.deepEqual(one(results, 'p:docs/a.md:DUP').conflicts, [{ reason: 'duplicate-key', withItemIds: ['s:docs/b.md#DUP', 's:docs/c.md#DUP'] }]);
  });

  const oldDocument = ['# 옛 문서', '', '- 상태: 확정', '- 근거: docs/ref.md', '', '첫 본문', '', '## 옛 절 1', '', '- 상태: 확정', '- 근거: docs/ref.md', '', '본문 1', '', '## 옛 절 2', '', '- 상태: 미확인', '', '본문 2', ''].join('\n');

  for (const target of ['docs/a.md', 'p:docs/a.md']) {
    it(`retires every item of a document replaced by the path ${target}`, () => {
      const results = resolveDocs([{ path: 'docs/a.md', text: oldDocument }, { path: 'docs/b.md', text: doc(entry('NEW', ...CONFIRMED, `대체: \`${target}\``)) }]);
      for (const anchor of ['옛-문서', '옛-절-1', '옛-절-2']) {
        const old = one(results, `p:docs/a.md:${anchor}`);
        assert.deepEqual(brief(old), ['deprecated', 'deprecated', 'superseded'], anchor);
        assert.deepEqual(old.basis.refs?.map((ref) => ref.targetItemId), ['s:docs/b.md#NEW'], anchor);
      }
      assert.deepEqual(brief(one(results, 'p:docs/b.md:NEW')), CONFIRMED_BRIEF);
    });
  }

  it('flags each confirmed item of a document replaced by an unconfirmed item', () => {
    const results = resolveDocs([{ path: 'docs/a.md', text: oldDocument }, { path: 'docs/b.md', text: doc(entry('NEW', '상태: 미확인', '대체: `docs/a.md`')) }]);
    for (const anchor of ['옛-문서', '옛-절-1']) assert.deepEqual(one(results, `p:docs/a.md:${anchor}`).conflicts, [{ reason: 'unconfirmed-supersession', withItemIds: [NEW_ID] }], anchor);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:옛-절-2')), ['unverified', 'unverified', 'declared']);
  });

  it('retires only the named item when the target has an anchor or a key', () => {
    for (const target of ['docs/a.md#옛-절-1']) {
      const results = resolveDocs([{ path: 'docs/a.md', text: oldDocument }, { path: 'docs/b.md', text: doc(entry('NEW', ...CONFIRMED, `대체: \`${target}\``)) }]);
      assert.deepEqual(brief(one(results, 'p:docs/a.md:옛-절-1')), ['deprecated', 'deprecated', 'superseded']);
      assert.equal(one(results, 'p:docs/a.md:옛-문서').baseStatus, 'confirmed_policy');
    }
  });

  it('retires nothing when two documents replace each other by path from different sections', () => {
    const results = resolveDocs([
      { path: 'docs/a.md', text: doc(entry('A1', ...CONFIRMED, '대체: `docs/b.md`'), entry('A2', ...CONFIRMED)) },
      { path: 'docs/b.md', text: doc(entry('B1', ...CONFIRMED), entry('B2', ...CONFIRMED, '대체: `docs/a.md`')) },
    ]);
    for (const id of ['p:docs/a.md:A1', 'p:docs/a.md:A2', 'p:docs/b.md:B1', 'p:docs/b.md:B2']) assert.deepEqual(brief(one(results, id)), CONFIRMED_BRIEF, id);
  });

  it('does not retire the replacing document when it names its own path', () => {
    const results = resolveDocs([{ path: 'docs/a.md', text: doc(entry('FIRST', ...CONFIRMED), entry('SECOND', ...CONFIRMED, '대체: `docs/a.md`')) }]);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:FIRST')), CONFIRMED_BRIEF);
    assert.deepEqual(brief(one(results, 'p:docs/a.md:SECOND')), CONFIRMED_BRIEF);
  });
});

describe('source rule', () => {
  it('rejects a confirming rule without a basis at config load', (t) => {
    const space = tempSpace(t);
    const path = space.path('sources.yaml');
    writeFileSync(path, ['schemaVersion: 1', 'database: {path: k.sqlite}', 'sources:', '  - {id: a, project: p, path: x, include: ["**"], rules: [{match: "a.md", status: confirmed_policy}]}'].join('\n'));
    assert.throws(
      () => loadSourcesConfig(path),
      (error: unknown) => error instanceof KnowledgeError && error.code === 'config-invalid',
    );
  });
});
