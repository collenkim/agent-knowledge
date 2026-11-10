import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';
import { EFFECTIVE_STATUSES, getItem, getItemV2, search, searchV2, type GetResponseV2, type OutputItemV2 } from '../src/index.js';
import type { BaseStatus, HttpOperation, InformalSyntax, ParsedItem, StatusDeclaration } from '../src/model.js';
import { buildDocumentItems, type BuildDocumentInput } from '../src/parsing/build-items.js';
import { isHttpOperation, operationsOf } from '../src/parsing/fields.js';
import { scanMarkdown } from '../src/parsing/markdown.js';
import { SEGMENT_MAX_CHARS, splitSegments } from '../src/parsing/segments.js';
import { tokenCountOf } from '../src/parsing/tokenize.js';
import { CHUNKER_VERSION, PARSER_VERSION, TOKENIZER_VERSION } from '../src/parsing/versions.js';
import { sha256 } from '../src/util/hash.js';
import { knowledgeFixture, type KnowledgeFixture, type RepoFiles } from './helpers.js';

function build(text: string, extra: Partial<BuildDocumentInput> = {}) {
  return buildDocumentItems({ sourceId: 's', projectId: 'p', path: 'docs/guide.md', text, rule: null, defaultKind: 'reference', ...extra });
}

const entry = (...fields: string[]): ParsedItem => build(['### `K` 제목', ...fields].join('\n')).items[0]!;
const section = (...body: string[]): ParsedItem => build(['## H', ...body].join('\n')).items[0]!;
const op = (method: HttpOperation['method'], path: string, field: HttpOperation['field']): HttpOperation => ({ method, path, field });
const note = (raw: string, normalized: BaseStatus, syntax: InformalSyntax, applied: boolean): StatusDeclaration['informal'][number] => ({ raw, normalized, syntax, applied });
const codes = (result: ReturnType<typeof build>): string[] => result.diagnostics.map((diagnostic) => diagnostic.code);

/** 길이가 정확히 n인 한 줄 문단. 첫 낱말로 어느 문단인지 알아본다. */
function para(tag: string, n: number): string {
  assert.ok(n > tag.length + 1);
  return `${tag} ${'x'.repeat(n - tag.length - 1)}`;
}

function linesOf(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** 조각이 항목 본문을 빈 줄만 빼고 빠짐없이, 겹치지 않게 덮는지 본다. */
function assertCovering(text: string, item: ParsedItem): void {
  const lines = linesOf(text);
  const { segments } = item;
  assert.ok(segments.length >= 2, `${item.anchor} has segments`);
  assert.equal(segments[0]!.startLine, item.startLine);
  assert.equal(segments.at(-1)!.endLine, item.endLine);
  const rebuilt: string[] = [];
  let previousEnd = item.startLine - 1;
  for (const [index, segment] of segments.entries()) {
    assert.equal(segment.ordinal, index + 1);
    assert.equal(segment.segmentId, `${item.itemId}#${index + 1}`);
    assert.ok(segment.startLine > previousEnd && segment.endLine >= segment.startLine);
    assert.equal(segment.content, lines.slice(segment.startLine - 1, segment.endLine).join('\n'));
    assert.equal(segment.contentSha256, sha256(segment.content));
    assert.notEqual(lines[segment.startLine - 1]!.trim(), '', 'a segment starts with text');
    assert.notEqual(lines[segment.endLine - 1]!.trim(), '', 'a segment ends with text');
    const gap = lines.slice(previousEnd, segment.startLine - 1);
    assert.ok(gap.every((line) => line.trim() === ''), 'only blank lines lie between segments');
    rebuilt.push(...gap, segment.content);
    previousEnd = segment.endLine;
  }
  assert.equal(rebuilt.join('\n'), item.content);
}

const starts = (item: ParsedItem): number[] => item.segments.map((segment) => segment.startLine);
const spans = (item: ParsedItem): [number, number][] => item.segments.map((segment) => [segment.startLine, segment.endLine]);

/** 범위 [from, to] 안쪽(첫 줄 제외)에서 시작하는 조각이 없는지 본다. */
function assertNotCutInside(item: ParsedItem, from: number, to: number, label: string): void {
  for (const start of starts(item)) assert.ok(start <= from || start > to, `${label}: segment starts at ${start} inside ${from}-${to}`);
  const holder = item.segments.find((segment) => segment.startLine <= from && segment.endLine >= from);
  assert.ok(holder, `${label}: some segment holds line ${from}`);
  assert.ok(holder.endLine >= to, `${label}: the block ends in the same segment`);
}

function lineNumberOf(text: string, line: string): number {
  const index = linesOf(text).indexOf(line);
  assert.ok(index >= 0, `missing line ${line.slice(0, 20)}`);
  return index + 1;
}

function indexed(t: TestContext, files: RepoFiles): KnowledgeFixture {
  const fixture = knowledgeFixture(t, [{ id: 'docs', project: 'p', files }]);
  fixture.index();
  return fixture;
}

function openDb(fixture: KnowledgeFixture): DatabaseSync {
  return fixture.space.track(new DatabaseSync(fixture.dbPath, { readOnly: true }));
}

describe('HTTP operations', () => {
  it('recognizes a method followed by blanks or a colon and an absolute path', () => {
    for (const token of ['PATCH /auth/password', 'GET:/auth/login', 'patch /x', 'Delete\t/a/{id}', 'OPTIONS /', 'CONNECT:/tunnel']) {
      assert.equal(isHttpOperation(token), true, token);
    }
    for (const token of ['/auth/logout', 'src/auth/password.ts', 'PATCH auth/password', 'GETX /a', 'GET', 'GET: /a', 'FETCH /a', 'https://x.io/a', 'GET /a b']) {
      assert.equal(isHttpOperation(token), false, token);
    }
  });

  it('keeps a scope operation out of applies-to paths with or without backticks', () => {
    for (const value of ['PATCH /auth/password', '`PATCH /auth/password`', 'PATCH:/auth/password']) {
      const item = entry(`- 범위: ${value}`);
      assert.deepEqual(item.appliesTo, { global: false, paths: [], phases: [], conditions: value.replaceAll('`', '') }, value);
      assert.deepEqual(item.operations, [op('PATCH', '/auth/password', 'scope')], value);
    }
  });

  it('keeps real paths next to an operation in the same scope', () => {
    const item = entry('- 범위: `PATCH /auth/password`, src/auth/password.ts', '- 적용조건: 야간');
    assert.deepEqual(item.appliesTo, { global: false, paths: ['src/auth/password.ts'], phases: [], conditions: 'PATCH /auth/password 야간' });
    assert.deepEqual(item.operations, [op('PATCH', '/auth/password', 'scope')]);
  });

  it('keeps a code or test operation out of code paths', () => {
    const colon = entry('- 코드: GET:/auth/login');
    assert.equal(colon.relations.code, undefined);
    assert.deepEqual(colon.operations, [op('GET', '/auth/login', 'code')]);

    const mixed = entry('- 코드: `GET /auth/login`, src/auth/login.ts', '- 테스트: POST /auth/login, tests/login.test.ts', '- 관련 코드: PUT:/auth/me');
    assert.deepEqual(mixed.relations.code, ['src/auth/login.ts']);
    assert.deepEqual(mixed.relations.test, ['tests/login.test.ts']);
    assert.deepEqual(mixed.operations, [op('GET', '/auth/login', 'code'), op('PUT', '/auth/me', 'code'), op('POST', '/auth/login', 'test')]);

    // 줄 번호 접미사를 떼어 내도 작업은 경로가 되지 않는다
    assert.equal(entry('- 코드: `GET /auth/login:12`, `POST:/auth/x#L3`').relations.code, undefined);
  });

  it('normalizes the method, strips trailing punctuation and dedupes per field', () => {
    assert.deepEqual(entry('- 범위: patch /x, PATCH /x. (PATCH /x) `patch /x`;').operations, [op('PATCH', '/x', 'scope')]);
    assert.deepEqual(operationsOf('GET /a/b), POST:/c.; delete /d"', 'test'), [op('GET', '/a/b', 'test'), op('POST', '/c', 'test'), op('DELETE', '/d', 'test')]);
    assert.deepEqual(operationsOf('GET /a·POST /b', 'scope'), [op('GET', '/a', 'scope'), op('POST', '/b', 'scope')]);
    assert.deepEqual(entry('- 범위: GET /a', '- 코드: GET /a', '- 테스트: get /a').operations, [op('GET', '/a', 'code'), op('GET', '/a', 'scope'), op('GET', '/a', 'test')]);
    assert.deepEqual(entry('- 범위: PUT /b, DELETE /b, GET /c, GET /a').operations, [op('DELETE', '/b', 'scope'), op('GET', '/a', 'scope'), op('GET', '/c', 'scope'), op('PUT', '/b', 'scope')]);
  });

  it('reads operations only from scope, code and test fields outside opaque blocks', () => {
    assert.deepEqual(entry('- 조건: GET /a', '- 정책: POST /b', '- 근거: PUT /c', 'DELETE /d 를 호출한다.').operations, []);
    assert.deepEqual(entry('- 범위: XGET /a, GETTER /b, GET', '- 코드: FETCH /c, OUTPUT /d').operations, []);
    const fenced = section('```', '- 범위: GET /a', '- 코드: POST:/b', '```', '<!--', '- 테스트: PUT /c', '-->');
    assert.deepEqual(fenced.operations, []);
    assert.equal(fenced.appliesTo.conditions, null);
  });

  it('never reads an operation as a path basis', () => {
    assert.deepEqual(entry('- 근거: `GET:/auth/x`').basisRefs, [{ kind: 'opaque', value: 'GET:/auth/x' }]);
    assert.deepEqual(entry('- 근거: `PATCH /auth/x`, docs/a.md').basisRefs, [{ kind: 'opaque', value: 'PATCH /auth/x, docs/a.md' }]);
  });

  it('takes operations out of frontmatter paths and code relations', () => {
    const doc = ['---', 'applies_to:', '  paths: [POST /a, src/x.ts]', '  conditions: [야간]', 'relations:', '  code: [DELETE /a, src/a.ts]', '  test: ["put:/t"]', '---', '## H', '본문', '', '## I', '본문'].join('\n');
    const { items, diagnostics } = build(doc);
    assert.deepEqual(diagnostics, []);
    for (const item of items) {
      assert.deepEqual(item.appliesTo, { global: false, paths: ['src/x.ts'], phases: [], conditions: '야간 POST /a' }, item.anchor);
      assert.deepEqual(item.relations, { code: ['src/a.ts'] }, item.anchor);
      assert.deepEqual(item.operations, [op('DELETE', '/a', 'code'), op('POST', '/a', 'scope'), op('PUT', '/t', 'test')], item.anchor);
    }

    const only = build(['---', 'applies_to:', '  paths: get /status', 'relations:', '  code: DELETE /a', '---', '## H', '본문'].join('\n')).items[0]!;
    assert.deepEqual(only.appliesTo, { global: false, paths: [], phases: [], conditions: 'get /status' });
    assert.deepEqual(only.relations, {});
    assert.deepEqual(only.operations, [op('DELETE', '/a', 'code'), op('GET', '/status', 'scope')]);
  });

  it('keeps ordinary and backslash paths as paths and a bare absolute path as a condition', () => {
    const item = entry('- 범위: src/auth/password.ts, docs/a.md, src\\auth\\login.ts, /auth/logout');
    assert.deepEqual(item.appliesTo, { global: false, paths: ['docs/a.md', 'src/auth/login.ts', 'src/auth/password.ts'], phases: [], conditions: '/auth/logout' });
    assert.deepEqual(item.operations, []);

    const code = entry('- 코드: src\\auth\\login.ts, /auth/logout, docs/a.md', '- 테스트: `tests/a.test.ts:3`');
    assert.deepEqual(code.relations.code, ['docs/a.md', 'src/auth/login.ts']);
    assert.deepEqual(code.relations.test, ['tests/a.test.ts']);
    assert.deepEqual(code.operations, []);

    // 확장자 없는 백슬래시 디렉터리도 `/`로 바꿔 경로로 읽는다. 드라이브 문자로 시작하면 저장소 밖이므로 조건으로 남는다
    const folders = entry('- 범위: src\\auth\\, `src\\billing`, C:\\work\\x', '- 코드: src\\auth\\handlers');
    assert.deepEqual(folders.appliesTo, { global: false, paths: ['src/auth/', 'src/billing'], phases: [], conditions: 'C:\\work\\x' });
    assert.deepEqual(folders.relations.code, ['src/auth/handlers']);
    assert.deepEqual(entry('- 근거: docs\\policy\\a.md#규칙').basisRefs, [{ kind: 'path', value: 'docs/policy/a.md', anchor: '규칙' }]);
  });

  it('keeps operations out of code locations and shows them only in response version 2', (t) => {
    const fixture = indexed(t, {
      'docs/auth.md': [
        '# 인증 규칙',
        '',
        '- 범위: `PATCH /auth/password`, src/auth',
        '- 코드: GET:/auth/login, `PATCH /auth/password`, src/auth/login.ts',
        '- 테스트: POST /auth/login',
        '',
        'passwordrule 비밀번호 변경 규칙이다.',
        '',
      ].join('\n'),
      'src/auth/login.ts': 'export {};\n',
    });
    const id = 'docs:docs/auth.md#인증-규칙';
    const v1 = search(fixture.context, { profile: 'code', query: 'passwordrule', scope: { projects: ['p'] } });
    assert.deepEqual(v1.items.map((item) => item.id), [id]);
    assert.deepEqual(v1.codeLocations.map((location) => [location.path, location.relation, location.resolved]), [['src/auth/login.ts', 'code', true]]);
    assert.deepEqual(v1.items[0]!.applicability.paths, ['src/auth']);
    assert.equal(v1.items[0]!.applicability.conditions, 'PATCH /auth/password');
    assert.ok(!('operations' in v1.items[0]!));
    assert.deepEqual(v1.items[0]!.links.map((link) => [link.relation, link.target]), [['code', 'src/auth/login.ts']]);

    const v2 = searchV2(fixture.context, { responseVersion: 2, profile: 'code', query: 'passwordrule', scope: { projects: ['p'] } });
    assert.deepEqual(v2.codeLocations, v1.codeLocations);
    assert.deepEqual(v2.items[0]!.operations, [op('GET', '/auth/login', 'code'), op('PATCH', '/auth/password', 'code'), op('PATCH', '/auth/password', 'scope'), op('POST', '/auth/login', 'test')]);

    const db = openDb(fixture);
    const row = db.prepare('SELECT operations_json AS operations FROM items WHERE item_id = ?').get(id) as unknown as { operations: string };
    assert.deepEqual(JSON.parse(row.operations), v2.items[0]!.operations);
  });
});

describe('status notation', () => {
  it('applies a demoting plain line or table row and marks it applied', () => {
    for (const [line, raw, syntax] of [
      ['상태: 폐기', '폐기', 'plain'],
      ['**상태**: 폐기', '폐기', 'plain'],
      ['status： deprecated', 'deprecated', 'plain'],
      ['| 상태 | 폐기 |', '폐기', 'table'],
      ['| status | deprecated |', 'deprecated', 'table'],
    ] as const) {
      const result = build(['## H', line, '본문'].join('\n'));
      const item = result.items[0]!;
      assert.equal(item.declaredStatus, 'deprecated', line);
      assert.equal(item.declaredStatusRaw, raw, line);
      assert.deepEqual(item.declaration, { origin: 'informal', informal: [note(raw, 'deprecated', syntax, true)] }, line);
      assert.deepEqual(codes(result), ['unrecognized-status-field'], line);
    }
  });

  it('records ordered-list and quote notations without applying them', () => {
    for (const [line, syntax] of [
      ['1. 상태: 폐기', 'ordered-list'],
      ['1) 상태: 폐기', 'ordered-list'],
      ['12. **상태**: 폐기', 'ordered-list'],
      ['  3. status: 폐기', 'ordered-list'],
      ['> 상태: 폐기', 'quote'],
      ['>상태: 폐기', 'quote'],
      ['> - 상태: 폐기', 'quote'],
      ['> > 상태: 폐기', 'quote'],
      ['>> * 상태: 폐기', 'quote'],
      ['   > **상태**: 폐기', 'quote'],
      ['> 1. 상태: 폐기', 'quote'],
      ['> | 상태 | 폐기 |', 'quote'],
    ] as const) {
      const result = build(['## H', line, '본문'].join('\n'));
      const item = result.items[0]!;
      assert.equal(item.declaredStatusRaw, null, line);
      assert.equal(item.declaredStatus, null, line);
      assert.deepEqual(item.declaration, { origin: null, informal: [note('폐기', 'deprecated', syntax, false)] }, line);
      assert.deepEqual(codes(result), ['unrecognized-status-field'], line);
    }
  });

  it('does not let an ordered-list or quote notation demote an inherited status', () => {
    for (const line of ['1. 상태: 폐기', '> 상태: 폐기', '> - 상태: 미확인']) {
      const item = build(['---', 'status: 확정', 'status_basis: docs/a.md', '---', '## H', line, '본문'].join('\n')).items[0]!;
      assert.equal(item.declaredStatus, 'confirmed_policy', line);
      assert.equal(item.declaration.origin, 'frontmatter', line);
      assert.deepEqual(item.declaration.informal.map((entry) => entry.applied), [false], line);
    }
  });

  it('never applies a confirming informal value whatever the notation', () => {
    for (const [line, raw, normalized, syntax] of [
      ['상태: 확정', '확정', 'confirmed_policy', 'plain'],
      ['**상태**: 확정 정책', '확정 정책', 'confirmed_policy', 'plain'],
      ['| 상태 | 검증됨 |', '검증됨', 'verified_experience', 'table'],
      ['1. 상태: 확정', '확정', 'confirmed_policy', 'ordered-list'],
      ['> - 상태: 확정', '확정', 'confirmed_policy', 'quote'],
      ['> status: verified', 'verified', 'verified_experience', 'quote'],
    ] as const) {
      const result = build(['## H', line, '- 근거: docs/a.md', '본문'].join('\n'));
      const item = result.items[0]!;
      assert.equal(item.declaredStatusRaw, null, line);
      assert.deepEqual(item.declaration, { origin: null, informal: [note(raw, normalized, syntax, false)] }, line);
      assert.deepEqual(item.basisRefs, [{ kind: 'path', value: 'docs/a.md' }], line);
      assert.deepEqual(codes(result), ['unrecognized-status-field'], line);
    }
  });

  it('marks only the lowest plain or table value as applied', () => {
    const item = section('상태: 관찰', '1. 상태: 폐기', '| 상태 | 미확인 |', '> 상태: 폐기');
    assert.equal(item.declaredStatus, 'unverified');
    assert.deepEqual(item.declaration, {
      origin: 'informal',
      informal: [note('관찰', 'observed_behavior', 'plain', false), note('폐기', 'deprecated', 'ordered-list', false), note('미확인', 'unverified', 'table', true), note('폐기', 'deprecated', 'quote', false)],
    });
  });

  it('keeps a formal field over every informal notation', () => {
    const item = section('- 상태: 관찰', '상태: 폐기', '| 상태 | 폐기 |');
    assert.equal(item.declaredStatus, 'observed_behavior');
    assert.deepEqual(item.declaration, { origin: 'field', informal: [note('폐기', 'deprecated', 'plain', false), note('폐기', 'deprecated', 'table', false)] });
  });

  it('does not record a table header row or a value outside the vocabulary', () => {
    assert.deepEqual(section('| 상태 | 폐기 |', '|---|---|', '| a | b |').declaration, { origin: null, informal: [] });
    assert.deepEqual(section('1. 상태: 결제 완료', '> 상태: 확정 예정').declaration, { origin: null, informal: [] });
  });

  it('names the layer that supplied the status', () => {
    const doc = ['## A', '- 상태: 폐기', '', '### B', '1. 상태: 미확인', '본문', '', '## C', '상태: 미확인', '', '### D', '본문', '', '## E', '본문'].join('\n');
    const { items } = build(doc);
    assert.deepEqual(
      items.map((item) => [item.anchor, item.declaredStatus, item.declaration.origin]),
      [
        ['a', 'deprecated', 'field'],
        ['b', 'deprecated', 'ancestor-field'],
        ['c', 'unverified', 'informal'],
        ['d', 'unverified', 'ancestor-informal'],
        ['e', null, null],
      ],
    );
    assert.deepEqual(items[1]!.declaration.informal, [note('미확인', 'unverified', 'ordered-list', false)]);
    assert.deepEqual(items[3]!.declaration.informal, []);

    const fromFrontmatter = build(['---', 'status: 폐기', '---', '## A', '본문', '', '### B', '상태: 관찰', '- 상태: 미확인'].join('\n')).items;
    assert.deepEqual(fromFrontmatter.map((item) => item.declaration.origin), ['frontmatter', 'field']);
    assert.deepEqual(build(['---', 'id: X-1', 'status: 폐기', '---'].join('\n')).items[0]!.declaration, { origin: 'frontmatter', informal: [] });

    const intro = build(['상태: 폐기', '', '# H', '본문'].join('\n')).items;
    assert.deepEqual(intro.map((item) => [item.anchor, item.declaration.origin]), [['_intro', 'informal'], ['h', null]]);
  });

  it('confirms only a formal field with a resolvable basis in the index', (t) => {
    const fixture = indexed(t, {
      'docs/basis.md': '# 근거 문서\n\n근거 본문이다.\n',
      'docs/formal.md': '## 정식\n\n- 상태: 확정\n- 근거: docs/basis.md\n\n본문이다.\n',
      'docs/missing.md': '## 근거 없음\n\n- 상태: 확정\n\n본문이다.\n',
      'docs/informal.md': [
        '## 평문',
        '상태: 확정',
        '- 근거: docs/basis.md',
        '',
        '## 표',
        '| 상태 | 확정 |',
        '',
        '- 근거: docs/basis.md',
        '',
        '## 번호',
        '1. 상태: 확정',
        '',
        '- 근거: docs/basis.md',
        '',
        '## 인용',
        '> - 상태: 확정',
        '',
        '- 근거: docs/basis.md',
        '',
        '## 검증 인용',
        '> 상태: 검증됨',
        '',
        '- 근거: docs/basis.md',
        '',
      ].join('\n'),
      'docs/demote.md': '## 평문 폐기\n\n상태: 폐기\n\n본문이다.\n\n## 번호 폐기\n\n1. 상태: 폐기\n\n본문이다.\n',
    });
    const knowledge = (id: string) => {
      const { item } = getItemV2(fixture.context, { responseVersion: 2, id, profile: 'master', scope: { projects: ['p'] } });
      const { status, confirmed, reason, declaration } = item.knowledge;
      return { status, confirmed, reason, origin: declaration === null ? 'missing' : declaration.origin };
    };
    assert.deepEqual(knowledge('docs:docs/formal.md#정식'), { status: 'confirmed_policy', confirmed: true, reason: 'basis-resolved', origin: 'field' });
    assert.deepEqual(knowledge('docs:docs/missing.md#근거-없음'), { status: 'unverified', confirmed: false, reason: 'status-basis-missing', origin: 'field' });
    for (const anchor of ['평문', '표', '번호', '인용', '검증-인용']) {
      assert.deepEqual(knowledge(`docs:docs/informal.md#${anchor}`), { status: 'unverified', confirmed: false, reason: 'status-not-declared', origin: null }, anchor);
    }
    assert.deepEqual(knowledge('docs:docs/demote.md#평문-폐기'), { status: 'deprecated', confirmed: false, reason: 'declared-deprecated', origin: 'informal' });
    assert.deepEqual(knowledge('docs:docs/demote.md#번호-폐기'), { status: 'unverified', confirmed: false, reason: 'status-not-declared', origin: null });

    const all = searchV2(fixture.context, { responseVersion: 2, profile: 'master', query: '본문이다 근거', scope: { projects: ['p'] }, filters: { statuses: [...EFFECTIVE_STATUSES] }, limit: 50 });
    const byId = new Map(all.items.map((item) => [item.id, item]));
    for (const anchor of ['평문', '표', '번호', '인용', '검증-인용']) assert.ok(byId.has(`docs:docs/informal.md#${anchor}`), anchor);
    assert.deepEqual(all.items.filter((item) => item.knowledge.confirmed).map((item) => item.id), ['docs:docs/formal.md#정식']);
    for (const item of all.items) {
      if (item.knowledge.declaration?.informal.length) assert.equal(item.knowledge.confirmed, false, item.id);
    }
    assert.deepEqual(byId.get('docs:docs/informal.md#인용')!.knowledge.declaration, { origin: null, informal: [note('확정', 'confirmed_policy', 'quote', false)] });
    assert.deepEqual(byId.get('docs:docs/demote.md#번호-폐기')!.knowledge.declaration, { origin: null, informal: [note('폐기', 'deprecated', 'ordered-list', false)] });
    assert.deepEqual(byId.get('docs:docs/demote.md#평문-폐기')!.knowledge.declaration, { origin: 'informal', informal: [note('폐기', 'deprecated', 'plain', true)] });

    const v1 = getItem(fixture.context, { id: 'docs:docs/demote.md#평문-폐기', profile: 'master', scope: { projects: ['p'] } });
    assert.ok(!('declaration' in v1.item.knowledge));
  });
});

describe('segments', () => {
  it('leaves an item of at most 1500 UTF-16 units unsplit', () => {
    assert.equal(SEGMENT_MAX_CHARS, 1500);
    const first = para('alpha', 700);
    // 제목 4자, 빈 줄 둘, 문단 사이 빈 줄 둘을 빼면 두째 문단이 792자일 때 정확히 한도다
    const exact = build(['## H', '', first, '', para('beta', 792)].join('\n')).items[0]!;
    assert.equal(exact.content.length, SEGMENT_MAX_CHARS);
    assert.deepEqual(exact.segments, []);

    const over = build(['## H', '', first, '', para('beta', 793)].join('\n')).items[0]!;
    assert.equal(over.content.length, SEGMENT_MAX_CHARS + 1);
    assert.deepEqual(spans(over), [[1, 3], [5, 5]]);

    // 코드 포인트로는 768자지만 UTF-16 단위로는 한도를 넘는다
    const astral = build(['## H', '', '😀'.repeat(400), '', '😀'.repeat(360)].join('\n')).items[0]!;
    assert.equal(astral.content.length, 1528);
    assert.deepEqual(spans(astral), [[1, 3], [5, 5]]);
  });

  it('does not split a long item that has no block boundary', () => {
    const lines = Array.from({ length: 20 }, (_, index) => para(`line${index}`, 100));
    const item = section(...lines);
    assert.ok(item.content.length > SEGMENT_MAX_CHARS);
    assert.deepEqual(item.segments, []);
    assert.deepEqual(splitSegments(para('one', 4000), 7, []), []);
  });

  it('splits only at paragraph starts after a blank line', () => {
    const paragraph = (tag: string) => Array.from({ length: 5 }, (_, index) => para(`${tag}${index}`, 90));
    const text = ['## 긴 절', ...paragraph('a'), '', ...paragraph('b'), '', ...paragraph('c'), '', ...paragraph('d')].join('\n');
    const item = build(text).items[0]!;
    assertCovering(text, item);
    const paragraphStarts = [1, 8, 14, 20];
    for (const start of starts(item)) assert.ok(paragraphStarts.includes(start), `segment starts at ${start}`);
    assert.deepEqual(spans(item), [[1, 12], [14, 24]]);
  });

  it('never cuts inside a fenced code block even across blank lines and headings', () => {
    const fenceBody = Array.from({ length: 18 }, (_, index) => (index % 3 === 0 ? `# 펜스 안 제목 ${index}` : para(`code${index}`, 150))).flatMap((line) => [line, '']);
    const text = ['## 코드 예시', para('intro', 600), '', '```md', ...fenceBody, '```', '', para('outro', 400)].join('\n');
    const { items } = build(text);
    assert.equal(items.length, 1, 'headings inside the fence are not sections');
    const [item] = items;
    const open = lineNumberOf(text, '```md');
    const close = linesOf(text).lastIndexOf('```') + 1;
    assertCovering(text, item!);
    assertNotCutInside(item!, open, close, 'fence');
    const fence = item!.segments.find((segment) => segment.startLine === open)!;
    assert.equal(fence.endLine, close);
    assert.ok(fence.content.length > SEGMENT_MAX_CHARS, 'an oversized fence stays whole');

    // 같은 본문을 불투명 표시 없이 나누면 펜스 안에서 자른다. 위 결과가 우연이 아님을 보인다
    const blind = splitSegments(item!.content, item!.startLine, []);
    assert.ok(blind.some((span) => span.startLine > open && span.startLine <= close));
  });

  it('never cuts inside a tilde fence, an HTML comment or a raw HTML block', () => {
    for (const [opener, closer] of [['~~~', '~~~'], ['<!--', '-->'], ['<pre>', '</pre>']] as const) {
      const inner = Array.from({ length: 6 }, (_, index) => para(`inner${index}`, 120)).flatMap((line) => [line, '', '## 아님']);
      const text = ['## 블록', para('head', 500), '', opener, ...inner, closer, '', para('tail', 500)].join('\n');
      const item = build(text).items[0]!;
      assert.equal(build(text).items.length, 1, opener);
      const open = lineNumberOf(text, opener);
      const close = lineNumberOf(text, closer);
      assertCovering(text, item);
      assertNotCutInside(item, open, close, opener);
    }
  });

  it('never cuts inside a table', () => {
    const rows = Array.from({ length: 25 }, (_, index) => `| r${index} | ${'y'.repeat(80)} |`);
    const text = ['## 표', para('before', 500), '', '| 이름 | 설명 |', '|---|---|', ...rows, '', para('after', 500)].join('\n');
    const item = build(text).items[0]!;
    const header = lineNumberOf(text, '| 이름 | 설명 |');
    const last = header + 1 + rows.length;
    assertCovering(text, item);
    assertNotCutInside(item, header, last, 'table');
    assert.deepEqual(spans(item), [[1, 2], [header, last], [last + 2, last + 2]]);
  });

  it('keeps a lead-in line with the block it introduces', () => {
    const doc = (leadIn: string) => ['## 허용 값', para('first', 700), '', leadIn, '', `- ${para('a', 300)}`, `- ${para('b', 300)}`, '', para('last', 700)].join('\n');
    const control = doc('허용하는 값은 다음과 같다.');
    const listLine = lineNumberOf(control, `- ${para('a', 300)}`);
    assert.ok(starts(build(control).items[0]!).includes(listLine), 'without a colon the list may start a segment');

    for (const leadIn of ['허용하는 값은 다음과 같다:', '허용하는 값은 다음과 같다：', '허용하는 값은 다음과 같다:  ', '**허용 값**:', '**다음 값만 허용한다:**', '_허용 값:_', '***허용 값：*** ']) {
      const text = doc(leadIn);
      const item = build(text).items[0]!;
      assertCovering(text, item);
      const leadLine = lineNumberOf(text, leadIn);
      assert.ok(!starts(item).includes(listLine), leadIn);
      const holder = item.segments.find((segment) => segment.startLine <= leadLine && segment.endLine >= leadLine)!;
      assert.ok(holder.endLine >= listLine + 1, `${leadIn}: the list stays with its lead-in`);
    }
  });

  it('keeps a heading with the block after it instead of making a heading-only segment', () => {
    // 제목만 든 조각은 근거가 없는데 제목 일치로 본문보다 앞선다
    const rows = Array.from({ length: 40 }, (_, index) => `| r${index} | ${'y'.repeat(40)} |`);
    const table = ['## 공개 API 목록', '', '| 이름 | 설명 |', '|---|---|', ...rows].join('\n');
    const lone = build(table).items[0]!;
    assert.ok(lone.content.length > SEGMENT_MAX_CHARS);
    assert.deepEqual(lone.segments, [], 'a heading and one oversized block are one group');

    const fence = ['## 스크립트', '', '```sh', ...Array.from({ length: 40 }, (_, index) => `echo ${'z'.repeat(40)} ${index}`), '```'].join('\n');
    assert.deepEqual(build(fence).items[0]!.segments, []);

    const text = [table, '', para('after', 600)].join('\n');
    const split = build(text).items[0]!;
    assertCovering(text, split);
    assert.deepEqual(spans(split), [[1, 44], [46, 46]]);
    for (const segment of split.segments) assert.ok(segment.content.split('\n').some((line) => line.trim() !== '' && !/^#{1,6}\s/.test(line)), `heading-only segment ${segment.startLine}`);
  });

  it('does not start a segment at a heading right after a lead-in line', () => {
    const doc = (tail: string) => ['### `K-1` 규칙', `${para('first', 800)}${tail}`, '#### 세부', para('second', 800)].join('\n');
    const control = build(doc('.')).items[0]!;
    assert.deepEqual(spans(control), [[1, 2], [3, 4]]);
    assert.deepEqual(build(doc(' 다음과 같다:')).items[0]!.segments, []);
  });

  it('starts a segment at an ATX heading inside an entry without a blank line', () => {
    const text = ['### `K-1` 규칙', para('first', 800), '#### 세부 둘', para('second', 800), '##### 세부 셋', para('third', 300)].join('\n');
    const { items } = build(text);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assertCovering(text, item);
    assert.ok(starts(item).includes(3), 'a segment starts at the sub-heading');
  });

  it('never cuts inside an indented list continuation', () => {
    const text = [
      '## 목록',
      `- ${para('one', 400)}`,
      '',
      `  ${para('cont', 400)}`,
      '',
      `  - ${para('sub', 400)}`,
      '',
      `\t${para('tab', 400)}`,
      '',
      `- ${para('two', 400)}`,
    ].join('\n');
    const item = build(text).items[0]!;
    assertCovering(text, item);
    assert.deepEqual(spans(item), [[1, 8], [10, 10]]);
    for (const segment of item.segments) assert.ok(!/^[ \t]/.test(segment.content), 'no segment starts indented');
  });

  it('packs blocks evenly instead of leaving a tiny tail', () => {
    const content = [para('one', 700), '', para('two', 700), '', para('three', 100)].join('\n');
    const segments = splitSegments(content, 10, []);
    // 한도까지 채우면 1402자와 100자가 되지만 고르게 나누면 700자와 802자다
    assert.deepEqual(segments.map((segment) => [segment.startLine, segment.endLine, segment.content.length]), [[10, 10, 700], [12, 14, 802]]);
    for (const segment of segments) assert.ok(segment.content.length <= SEGMENT_MAX_CHARS);

    const many = Array.from({ length: 5 }, (_, index) => para(`p${index}`, 600)).join('\n\n');
    assert.deepEqual(splitSegments(many, 1, []).map((segment) => segment.content.length), [1202, 1202, 600]);
  });

  it('keeps a single block longer than the limit whole', () => {
    const big = para('big', 2000);
    assert.deepEqual(splitSegments([big, '', para('small', 300)].join('\n'), 1, []).map((segment) => [segment.startLine, segment.endLine, segment.content.length]), [[1, 1, 2000], [3, 3, 300]]);
    const middle = splitSegments([para('a', 100), '', big, '', para('b', 100)].join('\n'), 1, []);
    assert.deepEqual(middle.map((segment) => [segment.startLine, segment.endLine, segment.content.length]), [[1, 1, 100], [3, 3, 2000], [5, 5, 100]]);
  });

  it('records absolute line ranges, ids, hashes and token counts and leaves the item unchanged', () => {
    const body = Array.from({ length: 6 }, (_, index) => para(`word${index}`, 400));
    const text = ['---', 'id: DOC-1', 'aliases: [별칭]', '---', '# 긴 문서', '', ...body.flatMap((line) => [line, '']), '## 짧은', '짧다'].join('\n');
    const { items } = build(text);
    const item = items[0]!;
    assert.equal(item.startLine, 5);
    assertCovering(text, item);
    assert.equal(item.content, linesOf(text).slice(4, item.endLine).join('\n'));
    assert.equal(item.contentSha256, sha256(item.content));
    assert.equal(item.tokenCount, tokenCountOf(item));
    for (const segment of item.segments) {
      assert.equal(segment.tokenCount, tokenCountOf({ key: item.key, aliases: item.aliases, title: item.title, headingPath: item.headingPath, content: segment.content }));
    }
    assert.ok(item.segments.every((segment) => segment.segmentId.startsWith('s:docs/guide.md#긴-문서#')));
    assert.deepEqual(items[1]!.segments, []);
  });

  it('splits CRLF and CR documents like LF ones', () => {
    const lf = ['## 줄바꿈', para('a', 700), '', '```', para('code', 300), '', para('code2', 300), '```', '', para('b', 700)].join('\n');
    const expected = build(lf).items[0]!.segments;
    assert.ok(expected.length >= 2);
    assert.deepEqual(build(lf.replaceAll('\n', '\r\n')).items[0]!.segments, expected);
    assert.deepEqual(build(lf.replaceAll('\n', '\r')).items[0]!.segments, expected);
  });

  it('agrees with the opaque lines scanMarkdown reports', () => {
    const text = ['## 혼합', para('a', 500), '', '    indented code', '', '    more code', '', para('b', 500), '', '<!-- x', '', para('hidden', 400), '-->', '', para('c', 500)].join('\n');
    const item = build(text).items[0]!;
    const { opaque } = scanMarkdown(text);
    const lines = linesOf(text);
    assertCovering(text, item);
    for (const start of starts(item).slice(1)) {
      const index = start - 1;
      const heading = !opaque[index] && /^ {0,3}#{1,6}(?:[ \t]|$)/.test(lines[index]!);
      const paragraph = lines[index - 1]!.trim() === '' && !opaque[index - 1] && !/^[ \t]/.test(lines[index]!);
      assert.ok(heading || paragraph, `boundary before line ${start}`);
    }
    assert.ok(!starts(item).includes(lineNumberOf(text, para('hidden', 400))));
  });
});

describe('segments in the index', () => {
  const LONG = [
    '# 긴 문서',
    '',
    '## 같은',
    para('alphaword', 700),
    '',
    para('betaword', 700),
    '',
    para('gammaword', 700),
    '',
    '## 같은',
    para('deltaword', 700),
    '',
    para('zebraword', 900),
    '',
    '## 짧은',
    '짧은 본문이다.',
    '',
  ].join('\n');

  it('gives duplicate headings distinct ids and attributes each segment to its own item', (t) => {
    const parsed = buildDocumentItems({ sourceId: 'docs', projectId: 'p', path: 'docs/long.md', text: LONG, rule: null, defaultKind: 'reference' });
    assert.deepEqual(
      parsed.items.map((item) => [item.itemId, item.startLine, item.endLine, item.segments.map((segment) => [segment.segmentId, segment.startLine, segment.endLine])]),
      [
        ['docs:docs/long.md#같은', 3, 8, [['docs:docs/long.md#같은#1', 3, 4], ['docs:docs/long.md#같은#2', 6, 8]]],
        ['docs:docs/long.md#같은-1', 10, 13, [['docs:docs/long.md#같은-1#1', 10, 11], ['docs:docs/long.md#같은-1#2', 13, 13]]],
        ['docs:docs/long.md#짧은', 15, 16, []],
      ],
    );
    for (const item of parsed.items) if (item.segments.length > 0) assertCovering(LONG, item);

    const fixture = indexed(t, { 'docs/long.md': LONG });
    const db = openDb(fixture);
    const rows = db
      .prepare(
        `SELECT i.item_id AS itemId, s.ordinal AS ordinal, s.segment_id AS segmentId, s.start_line AS startLine, s.end_line AS endLine, s.content AS content, s.content_sha256 AS contentSha256, s.token_count AS tokenCount
         FROM item_segments s JOIN items i ON i.item_pk = s.item_pk ORDER BY i.ordinal, s.ordinal`,
      )
      .all() as unknown as ({ itemId: string } & ParsedItem['segments'][number])[];
    assert.deepEqual(
      rows.map(({ itemId, ...segment }) => [itemId, { ...segment }]),
      parsed.items.flatMap((item) => item.segments.map((segment) => [item.itemId, { ...segment }])),
    );
    const ftsCount = (db.prepare('SELECT count(*) AS value FROM segments_fts').get() as unknown as { value: number }).value;
    assert.equal(ftsCount, rows.length);
    const stored = db.prepare('SELECT declaration_json AS declaration, token_count AS tokenCount FROM items ORDER BY ordinal').all() as unknown as { declaration: string; tokenCount: number }[];
    assert.deepEqual(stored.map((row) => [JSON.parse(row.declaration), row.tokenCount]), parsed.items.map((item) => [item.declaration, item.tokenCount]));

    const found = searchV2(fixture.context, { responseVersion: 2, profile: 'master', query: 'zebraword', scope: { projects: ['p'] }, segments: true });
    const hit = found.items.find((item) => item.selection.directRank !== null) as OutputItemV2;
    assert.equal(hit.id, 'docs:docs/long.md#같은-1');
    assert.deepEqual(hit.segment, { id: 'docs:docs/long.md#같은-1#2', ordinal: 2, count: 2, startLine: 13, endLine: 13, sha256: sha256(para('zebraword', 900)), heading: null });
    assert.equal(hit.ref.segmentId, 'docs:docs/long.md#같은-1#2');
    assert.ok(hit.provenance.excerptStartLine >= 13 && hit.provenance.excerptEndLine <= 13);

    const first = searchV2(fixture.context, { responseVersion: 2, profile: 'master', query: 'alphaword', scope: { projects: ['p'] }, segments: true });
    assert.equal(first.items[0]!.id, 'docs:docs/long.md#같은');
    assert.deepEqual([first.items[0]!.segment?.id, first.items[0]!.segment?.heading], ['docs:docs/long.md#같은#1', '같은']);

    const fetched: GetResponseV2 = getItemV2(fixture.context, { responseVersion: 2, id: 'docs:docs/long.md#같은#2', profile: 'master', scope: { projects: ['p'] } });
    assert.equal(fetched.item.id, 'docs:docs/long.md#같은');
    assert.equal(fetched.item.segmentContent, [para('betaword', 700), '', para('gammaword', 700)].join('\n'));
    assert.equal(fetched.item.content, parsed.items[0]!.content);
  });

  it('gives a keyed entry whose key holds a hash an unambiguous segment id', () => {
    const text = ['### `A#1` 규칙', para('one', 800), '', para('two', 800)].join('\n');
    const item = build(text).items[0]!;
    assert.equal(item.anchor, 'A%231');
    assert.deepEqual(item.segments.map((segment) => segment.segmentId), ['s:docs/guide.md#A%231#1', 's:docs/guide.md#A%231#2']);
  });
});

describe('parser versions', () => {
  it('records md-2, chunk-2 and tok-1 in the index and provenance', (t) => {
    assert.deepEqual([PARSER_VERSION, CHUNKER_VERSION, TOKENIZER_VERSION], ['md-2', 'chunk-2', 'tok-1']);
    const fixture = indexed(t, { 'docs/a.md': '# 버전\n\nversionword 본문이다.\n' });
    const response = search(fixture.context, { profile: 'master', query: 'versionword', scope: { projects: ['p'] } });
    assert.deepEqual([response.index.parserVersion, response.index.chunkerVersion, response.index.tokenizerVersion], ['md-2', 'chunk-2', 'tok-1']);
    assert.deepEqual([response.items[0]!.provenance.parserVersion, response.items[0]!.provenance.chunkerVersion], ['md-2', 'chunk-2']);
    const v2 = searchV2(fixture.context, { responseVersion: 2, profile: 'master', query: 'versionword', scope: { projects: ['p'] } });
    assert.equal(v2.retrieval.segments.chunkerVersion, 'chunk-2');
  });
});

