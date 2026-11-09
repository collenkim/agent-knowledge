import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeStatus, type ParsedItem } from '../src/model.js';
import { buildDocumentItems, type BuildDocumentInput } from '../src/parsing/build-items.js';
import { hangulBigrams, indexColumns, wordsOf } from '../src/parsing/tokenize.js';
import { sha256 } from '../src/util/hash.js';

function build(text: string, extra: Partial<BuildDocumentInput> = {}) {
  return buildDocumentItems({ sourceId: 's', projectId: 'p', path: 'docs/guide.md', text, rule: null, defaultKind: 'reference', ...extra });
}

function shape(items: ParsedItem[]) {
  return items.map((item) => [item.anchor, item.unit, item.startLine, item.endLine]);
}

function assertExactRanges(text: string, items: ParsedItem[]): void {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  let previousEnd = 0;
  for (const item of items) {
    assert.ok(item.startLine > previousEnd, `${item.anchor} overlaps the previous item`);
    assert.ok(item.endLine >= item.startLine);
    assert.equal(item.content, lines.slice(item.startLine - 1, item.endLine).join('\n'));
    assert.equal(item.contentSha256, sha256(item.content));
    previousEnd = item.endLine;
  }
}

describe('heading splits', () => {
  const text = ['# 제목', '소개', '', '## 둘', '둘 본문', '', '### 셋', '셋 본문', '', '', '## 넷', '넷 본문', ''].join('\n');

  it('splits at every heading level without nesting bodies', () => {
    const { items, title } = build(text);
    assert.equal(title, '제목');
    assert.deepEqual(shape(items), [
      ['제목', 'section', 1, 2],
      ['둘', 'section', 4, 5],
      ['셋', 'section', 7, 8],
      ['넷', 'section', 11, 12],
    ]);
    assert.ok(!items[1]!.content.includes('셋 본문'));
    assert.deepEqual(items[2]!.headingPath, ['제목', '둘', '셋']);
    assertExactRanges(text, items);
  });

  it('builds item ids from source, path and anchor', () => {
    assert.equal(build(text).items[1]!.itemId, 's:docs/guide.md#둘');
  });

  it('emits no item for a heading-only section but keeps it in heading paths', () => {
    const doc = ['## 상위', '', '### 하위', '본문'].join('\n');
    const { items } = build(doc);
    assert.deepEqual(shape(items), [['하위', 'section', 3, 4]]);
    assert.deepEqual(items[0]!.headingPath, ['상위', '하위']);
  });

  it('turns text before the first heading into a document item titled from frontmatter or H1', () => {
    const { items } = build(['앞글', '', '# 큰 제목', '본문'].join('\n'));
    assert.deepEqual(shape(items), [['_intro', 'document', 1, 1], ['큰-제목', 'section', 3, 4]]);
    assert.equal(items[0]!.title, '큰 제목');
    assert.equal(build(['---', 'title: 앞제목', '---', '앞글'].join('\n')).items[0]!.title, '앞제목');
  });

  it('strips closing hashes and accepts indented or empty ATX headings', () => {
    const { items } = build(['   ## 닫힘 ##', '본문', '#없음', '##', '빈 제목 본문'].join('\n'));
    assert.deepEqual(items.map((item) => item.title), ['닫힘', '']);
    assert.equal(items[0]!.endLine, 3);
    assert.equal(items[1]!.anchor, 'section');
  });

  it('falls back to the file name when the first H1 is empty', () => {
    assert.equal(build(['#', '본문'].join('\n')).title, 'guide');
  });
});

describe('frontmatter', () => {
  const text = ['---', 'title: 문서', 'kind: policy', 'status: 확정', 'status_basis: docs/a.md', 'mandatory: true', 'id: DOC-1', 'aliases: [별명]', '---', '', '# H', '본문', '', '## 둘', '둘 본문'].join('\n');

  it('offsets line numbers by the frontmatter and applies its metadata', () => {
    const { items, title } = build(text);
    assert.equal(title, '문서');
    assert.deepEqual(shape(items), [['h', 'section', 11, 12], ['둘', 'section', 14, 15]]);
    assertExactRanges(text, items);
    assert.equal(items[0]!.kind, 'policy');
    assert.equal(items[1]!.declaredStatus, 'confirmed_policy');
    assert.deepEqual(items[1]!.basisRefs, [{ kind: 'path', value: 'docs/a.md' }]);
    assert.equal(items[1]!.mandatory, true);
  });

  it('gives the id and aliases only to the first emitted item', () => {
    const { items } = build(text);
    assert.equal(items[0]!.key, 'DOC-1');
    assert.deepEqual(items[0]!.aliases, ['별명', '문서']);
    assert.equal(items[1]!.key, null);
    assert.deepEqual(items[1]!.aliases, []);
  });

  it('reports a schema error in recognised frontmatter but still indexes the document', () => {
    const { items, diagnostics } = build(['---', 'title: [1]', '---', '# H', '본문'].join('\n'));
    assert.deepEqual(diagnostics.map((d) => d.code), ['invalid-frontmatter']);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.startLine, 4);
  });

  it('reports a blank-looking region the YAML parser rejects instead of failing', () => {
    const { items, diagnostics } = build(['---', '\t　', '---', '# 제목', '', '본문'].join('\n'));
    assert.deepEqual(diagnostics.map((d) => d.code), ['invalid-frontmatter']);
    assert.deepEqual(items.map((item) => item.anchor), ['제목']);
  });

  it('indexes unparseable YAML as body and keeps reporting it', () => {
    const { items, diagnostics } = build(['---', 'a: [', '---', '# H', '본문'].join('\n'));
    assert.deepEqual(diagnostics.map((d) => d.code), ['invalid-frontmatter']);
    assert.deepEqual(shape(items), [['_intro', 'document', 2, 3], ['h', 'section', 4, 5]]);
    assert.equal(items[0]!.content, 'a: [\n---');
  });

  it('indexes a non-mapping region as body without a diagnostic', () => {
    const { items, diagnostics } = build(['---', '- list', '---', '# H', '본문'].join('\n'));
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(shape(items), [['_intro', 'document', 2, 3], ['h', 'section', 4, 5]]);
  });

  it('reports unknown kind and status and falls back', () => {
    const { items, diagnostics } = build(['---', 'kind: nope', 'status: 곧확정', '---', '# H', '본문'].join('\n'), { defaultKind: 'plan' });
    assert.deepEqual(diagnostics.map((d) => d.code), ['unknown-kind', 'unknown-status-value']);
    assert.equal(items[0]!.kind, 'plan');
    assert.equal(items[0]!.declaredStatus, null);
    assert.equal(items[0]!.declaredStatusRaw, '곧확정');
  });

  it('treats an unclosed or indented delimiter as body', () => {
    assert.equal(build(['---', 'title: x', '# H', '본문'].join('\n')).items.at(-1)!.startLine, 3);
    const indented = build([' ---', 'title: x', '---', '본문'].join('\n')).items;
    assert.deepEqual(shape(indented), [['title-x', 'section', 2, 4]]);
  });
});

describe('fences and comments', () => {
  it('ignores headings inside fences of either character', () => {
    const doc = ['# H', '```md', '# 아님', '```', '~~~', '## 아님', '~~~', '## 진짜', '본문'].join('\n');
    assert.deepEqual(shape(build(doc).items), [['h', 'section', 1, 7], ['진짜', 'section', 8, 9]]);
  });

  it('requires the same character and at least the same length to close', () => {
    const doc = ['# H', '````', '```', '# 아님', '~~~~', '````', '## 진짜', '본문'].join('\n');
    assert.deepEqual(build(doc).items.map((item) => item.anchor), ['h', '진짜']);
  });

  it('runs an unterminated fence to the end of the file', () => {
    const doc = ['# H', '```', '## 아님', '끝'].join('\n');
    assert.deepEqual(shape(build(doc).items), [['h', 'section', 1, 4]]);
  });

  it('allows up to three spaces before a fence and treats four as text', () => {
    assert.deepEqual(build(['# H', '   ```', '## 아님', '   ```'].join('\n')).items.length, 1);
    assert.deepEqual(build(['# H', '    ```', '## 진짜', '본문'].join('\n')).items.length, 2);
  });

  it('does not treat inline backticks as a fence', () => {
    assert.equal(build(['# H', '``` 인라인 ``` 글', '## 진짜', '본문'].join('\n')).items.length, 2);
  });

  it('ignores headings inside multi-line HTML comments but keeps their text', () => {
    const doc = ['# H', '<!--', '## 아님', '-->', '본문', '<!-- 한 줄 -->', '## 진짜', '본문'].join('\n');
    const { items } = build(doc);
    assert.deepEqual(shape(items), [['h', 'section', 1, 6], ['진짜', 'section', 7, 8]]);
    assert.ok(items[0]!.content.includes('## 아님'));
  });

  it('does not read fields inside fences', () => {
    const { items } = build(['## H', '```', '- 상태: 확정', '```', '- 코드: src/a.ts'].join('\n'));
    assert.equal(items[0]!.declaredStatusRaw, null);
    assert.deepEqual(items[0]!.relations.code, ['src/a.ts']);
  });
});

describe('setext headings', () => {
  it('recognizes level 1 and 2 underlines and includes the underline in content', () => {
    const doc = ['제목', '===', '본문', '', '둘째', '---', '둘째 본문'].join('\n');
    const { items } = build(doc);
    assert.deepEqual(shape(items), [['제목', 'section', 1, 3], ['둘째', 'section', 5, 7]]);
    assert.equal(items[0]!.content, '제목\n===\n본문');
    assertExactRanges(doc, items);
  });

  it('emits an item for an = underlined heading without body', () => {
    const { items } = build(['제목', '===', ''].join('\n'));
    assert.deepEqual(shape(items), [['제목', 'section', 1, 2]]);
    assert.equal(items[0]!.content, '제목\n===');
  });

  for (const [name, prior] of [['list', '- 항목'], ['numbered list', '1. 항목'], ['quote', '> 인용'], ['table', '| a | b |'], ['indented', '    코드']] as const) {
    it(`does not treat a thematic break after a ${name} line as an underline`, () => {
      assert.deepEqual(shape(build(['## 앞', '본문', prior, '---', '끝'].join('\n')).items), [['앞', 'section', 1, 5]]);
    });
  }

  it('does not treat a thematic break after an ATX heading as an underline', () => {
    assert.deepEqual(shape(build(['## 앞', '본문', '## 제목', '---', '끝'].join('\n')).items), [['앞', 'section', 1, 2], ['제목', 'section', 3, 5]]);
  });

  it('does not treat a thematic break after a blank line or comment as an underline', () => {
    assert.deepEqual(shape(build(['## 앞', '본문', '', '---', '끝'].join('\n')).items), [['앞', 'section', 1, 5]]);
    assert.deepEqual(shape(build(['## 앞', '<!-- 주석 -->', '---', '끝'].join('\n')).items), [['앞', 'section', 1, 4]]);
  });

  it('does not read frontmatter closers or fenced lines as underlines', () => {
    assert.deepEqual(build(['---', 'title: x', '---', '본문'].join('\n')).items.map((item) => item.unit), ['document']);
    assert.deepEqual(build(['```', '글', '---', '```', '끝'].join('\n')).items.map((item) => item.unit), ['document']);
  });
});

describe('line endings and BOM', () => {
  const lf = ['# H', '본문', '', '## 둘', '끝'].join('\n');

  it('produces identical items for CRLF, CR and LF', () => {
    const expected = build(lf).items;
    assert.deepEqual(build(lf.replaceAll('\n', '\r\n')).items, expected);
    assert.deepEqual(build(lf.replaceAll('\n', '\r')).items, expected);
  });

  it('handles CRLF inside frontmatter', () => {
    const { items, title } = build(['---', 'title: 문서', '---', '# H', '본문'].join('\r\n'));
    assert.equal(title, '문서');
    assert.equal(items[0]!.startLine, 4);
    assert.equal(items[0]!.content, '# H\n본문');
  });

  it('removes a leading BOM without shifting lines', () => {
    const { items } = build(`﻿${lf}`);
    assert.deepEqual(items, build(lf).items);
    assert.equal(build('﻿---\ntitle: 문서\n---\n# H\n본문').title, '문서');
  });

  it('counts lines without the empty string after a final newline', () => {
    assert.equal(build('# H\n본문\n').lineCount, 2);
    assert.equal(build('# H\n본문').lineCount, 2);
  });
});

describe('entries', () => {
  const doc = [
    '# 규칙',
    '',
    '## 주문',
    '',
    '### `BR-001` 취소 규칙',
    '- 상태: 확정',
    '',
    '### 일반 소제목',
    '안쪽 글',
    '',
    '#### 더 깊은 제목',
    '깊은 글',
    '',
    '### `BR-002`',
    '둘째 항목',
    '',
    '### 항목 뒤 일반',
    '여전히 둘째',
    '',
    '## 다른 절',
    '끝',
  ].join('\n');

  it('keeps plain h3/h4 inside and ends at keyed h3 or h1-2', () => {
    const { items } = build(doc);
    assert.deepEqual(shape(items), [
      ['BR-001', 'entry', 5, 12],
      ['BR-002', 'entry', 14, 18],
      ['다른-절', 'section', 20, 21],
    ]);
    assertExactRanges(doc, items);
  });

  it('takes the key and title and falls back to the key', () => {
    const { items } = build(doc);
    assert.equal(items[0]!.key, 'BR-001');
    assert.equal(items[0]!.title, '취소 규칙');
    assert.deepEqual(items[0]!.headingPath, ['규칙', '주문', 'BR-001 취소 규칙']);
    assert.equal(items[1]!.title, 'BR-002');
  });

  it('only level 3 unindented backtick headings are entries', () => {
    assert.equal(build(['## `A` 둘', '본문'].join('\n')).items[0]!.unit, 'section');
    assert.equal(build(['#### `A` 넷', '본문'].join('\n')).items[0]!.unit, 'section');
    assert.equal(build([' ### `A` 들여씀', '본문'].join('\n')).items[0]!.unit, 'section');
  });

  it('ignores keyed headings inside fences', () => {
    const { items } = build(['### `A`', '```', '### `B`', '```', '끝'].join('\n'));
    assert.deepEqual(items.map((item) => item.key), ['A']);
  });

  it('ends an entry before an h1', () => {
    assert.deepEqual(shape(build(['### `A`', '글', '# 큰', '글'].join('\n')).items), [['A', 'entry', 1, 2], ['큰', 'section', 3, 4]]);
  });
});

describe('anchors', () => {
  it('resolves foo, foo, foo-1 collisions in line order', () => {
    const doc = ['## foo', '글', '## foo', '글', '## foo-1', '글'].join('\n');
    assert.deepEqual(build(doc).items.map((item) => item.anchor), ['foo', 'foo-1', 'foo-1-1']);
  });

  it('counts non-emitted headings and headings inside entries', () => {
    assert.deepEqual(build(['## foo', '', '## foo', '글'].join('\n')).items.map((item) => item.anchor), ['foo-1']);
    assert.deepEqual(build(['### `K`', '#### foo', '글', '## foo', '글'].join('\n')).items.map((item) => item.anchor), ['K', 'foo-1']);
  });

  it('reserves _intro before headings', () => {
    assert.deepEqual(build(['글', '## _intro', '글'].join('\n')).items.map((item) => item.anchor), ['_intro', '_intro-1']);
  });

  it('slugifies with lowercase and unicode letters and replaces spaces', () => {
    assert.equal(build(['## Foo Bar! 주문 (v2)', '글'].join('\n')).items[0]!.anchor, 'foo-bar-주문-v2');
    assert.equal(build(['## `Code` 값', '글'].join('\n')).items[0]!.anchor, 'code-값');
    assert.equal(build(['## !!!', '글', '## ???', '글'].join('\n')).items.map((i) => i.anchor).join(), 'section,section-1');
  });

  it('percent-encodes entry keys and preserves their case', () => {
    assert.equal(build(['### `A#B%C D`', '글'].join('\n')).items[0]!.anchor, 'A%23B%25C-D');
  });
});

describe('duplicates and heading-less documents', () => {
  it('keeps duplicate headings and keys as separate items with unique anchors', () => {
    const { items } = build(['### `K` 하나', '글', '### `K` 둘', '글'].join('\n'));
    assert.deepEqual(items.map((item) => [item.key, item.anchor]), [['K', 'K'], ['K', 'K-1']]);
    assert.equal(new Set(items.map((item) => item.itemId)).size, 2);
  });

  it('turns a heading-less document into one document item titled by file name', () => {
    const doc = ['', '첫 글', '', '둘째 글', '', ''].join('\n');
    const { items, title } = build(doc, { path: 'docs/메모.final.md' });
    assert.equal(title, '메모.final');
    assert.deepEqual(shape(items), [['_intro', 'document', 2, 4]]);
    assert.equal(items[0]!.title, '메모.final');
    assert.equal(items[0]!.content, '첫 글\n\n둘째 글');
  });

  it('emits nothing for blank or frontmatter-only documents', () => {
    for (const doc of ['', '\n\n', '---\ntitle: x\n---\n']) assert.deepEqual(build(doc).items, []);
  });
});

describe('fields', () => {
  const entry = (...fields: string[]) => build(['### `K` 제목', ...fields].join('\n')).items[0]!;

  it('maps Korean and English status names and whitespace in field names', () => {
    assert.equal(entry('- 상태: 관찰').declaredStatus, 'observed_behavior');
    assert.equal(entry('* status： verified').declaredStatus, 'verified_experience');
    assert.deepEqual(entry('  - 관련 정책: `POL-1`').relations.policy, ['POL-1']);
  });

  it('keeps raw and nulls every value outside the exact vocabulary', () => {
    const item = entry('- 상태: 확정 예정');
    assert.equal(item.declaredStatus, null);
    assert.equal(item.declaredStatusRaw, '확정 예정');
    assert.deepEqual(build('### `K`\n- 상태: 확정 예정').diagnostics.map((d) => d.code), ['unknown-status-value']);
    assert.equal(entry('- 상태: 확정', '- 상태: 확정').declaredStatus, null);
  });

  it('normalizes the status vocabulary by whitespace and case only', () => {
    assert.equal(normalizeStatus('  확정   정책 '), 'confirmed_policy');
    assert.equal(normalizeStatus('CONFIRMED'), 'confirmed_policy');
    assert.equal(normalizeStatus('가설'), 'unverified');
    assert.equal(normalizeStatus('대체됨'), 'deprecated');
    assert.equal(normalizeStatus('constructor'), null);
  });

  it('treats 구분 as mandatory only on an exact value', () => {
    assert.equal(entry('- 구분: 필수').mandatory, true);
    assert.equal(entry('- 구분: mandatory').mandatory, true);
    assert.equal(entry('- 구분: 필수 아님').mandatory, false);
    assert.equal(entry('- 구분: 권장').mandatory, false);
  });

  it('parses basis references of every form', () => {
    assert.deepEqual(entry('- 근거: path:docs/a.md#앵커, `src/b.ts:10` · commit:abc1234', '- 출처: item:BR-1 verify:test').basisRefs, [
      { kind: 'path', value: 'docs/a.md', anchor: '앵커' },
      { kind: 'path', value: 'src/b.ts' },
      { kind: 'commit', value: 'abc1234' },
      { kind: 'item', value: 'BR-1' },
      { kind: 'verify', value: 'test' },
    ]);
    assert.deepEqual(entry('- 근거: 담당자').basisRefs, [{ kind: 'opaque', value: '담당자' }]);
    assert.deepEqual(entry('- 근거: https://example.com/x').basisRefs, [{ kind: 'opaque', value: 'https://example.com/x' }]);
    assert.deepEqual(entry('- 근거: ../x.md').basisRefs, [{ kind: 'opaque', value: '../x.md' }]);
  });

  it('splits scope into global, paths and conditions', () => {
    assert.deepEqual(entry('- 범위: 전체').appliesTo, { global: true, paths: [], phases: [], conditions: null });
    assert.deepEqual(entry('- 범위: `src/a b.ts`, ./src/orders/, 결제 시', '- 적용조건: 야간').appliesTo, {
      global: false,
      paths: ['src/a b.ts', 'src/orders/'],
      phases: [],
      conditions: '결제 시 야간',
    });
  });

  it('sends known phases to appliesTo and other tokens to flow links', () => {
    const item = entry('- 단계: implement, FLOW-9 test', '- 흐름: `주문 흐름`');
    assert.deepEqual(item.appliesTo.phases, ['implement', 'test']);
    assert.deepEqual(item.relations.flow, ['FLOW-9', '주문 흐름']);
  });

  it('extracts code and test paths and rejects URLs and outside paths', () => {
    const item = entry('- 코드: `./src/a.ts:12`, src\\b.ts 설명 https://x.io/a.ts ../c.ts', '- 테스트: tests/a.test.ts:3-9');
    assert.deepEqual(item.relations.code, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(item.relations.test, ['tests/a.test.ts']);
  });

  it('reads backticks verbatim and bare references only outside backticks, deduped and sorted', () => {
    assert.deepEqual(entry('- 정책: `b 규칙` POL-2, order-api:POL-1 XPOL-3 POL-2 `POL-9 안` 설명').relations.policy, ['POL-2', 'b 규칙', 'POL-9 안', 'order-api:POL-1'].sort());
  });

  it('splits aliases on comma and middle dot only', () => {
    assert.deepEqual(entry('- 별칭: 취소 규칙, `cancel`·환불').aliases, ['cancel', '취소 규칙', '환불'].sort());
  });

  it('skips unknown and table-like lines', () => {
    assert.deepEqual(entry('- 참고: 무시', '- a | 상태: 확정').relations, {});
    assert.equal(entry('- 참고: 무시', '- a | 상태: 확정').declaredStatusRaw, null);
  });

  it('parses fields for a document unit', () => {
    assert.equal(build('- 상태: 확정').items[0]!.declaredStatusRaw, '확정');
    assert.equal(build(['- 상태: 폐기', '', '# H', '본문'].join('\n')).items[0]!.declaredStatus, 'deprecated');
  });

  it('accepts the plus marker and emphasis around field names', () => {
    for (const line of ['+ 상태: 폐기', '- **상태**: 폐기', '- **상태:** 폐기', '- __상태__: 폐기', '- **상태: 폐기**', '* *상태*: 폐기']) {
      assert.equal(entry(line).declaredStatus, 'deprecated', line);
    }
  });

  it('keeps a free-text conflict or dependency as one target unless it says none', () => {
    assert.deepEqual(entry('- 충돌: 결제 정책과 다르다').relations.conflicts_with, ['결제 정책과 다르다']);
    assert.deepEqual(entry('- 충돌: ZZZ-9').relations.conflicts_with, ['ZZZ-9']);
    assert.deepEqual(entry('- 의존: payment-api').relations.dependency, ['payment-api']);
    for (const none of ['없음', 'none', 'N/A', '-', '']) {
      assert.equal(entry(`- 충돌: ${none}`).relations.conflicts_with, undefined, none);
      assert.equal(entry(`- 의존: ${none}`).relations.dependency, undefined, none);
    }
    assert.deepEqual(entry('- 충돌: `A` 설명').relations.conflicts_with, ['A']);
    assert.equal(entry('- 연결: 자유문').relations.related, undefined);
  });

  it('strips fragments from code links', () => {
    assert.deepEqual(entry('- 코드: src/foo.ts#L1').relations.code, ['src/foo.ts']);
    assert.deepEqual(entry('- 코드: `src/foo.ts:3#L3`').relations.code, ['src/foo.ts']);
  });

  it('keeps a basis value with prose as one opaque reference', () => {
    assert.deepEqual(entry('- 근거: docs/a.md 에서 확인함').basisRefs, [{ kind: 'opaque', value: 'docs/a.md 에서 확인함' }]);
    assert.deepEqual(entry('- 근거: path:docs/a.md 참고').basisRefs, [{ kind: 'opaque', value: 'path:docs/a.md 참고' }]);
    assert.deepEqual(entry('- 근거: docs/a.md 메모', '- 출처: docs/b.md').basisRefs, [
      { kind: 'opaque', value: 'docs/a.md 메모' },
      { kind: 'path', value: 'docs/b.md' },
    ]);
    const prose = build(['---', 'status_basis: docs/a.md 회의록', '---', '## H', '글'].join('\n')).items[0]!;
    assert.deepEqual(prose.basisRefs, [{ kind: 'opaque', value: 'docs/a.md 회의록' }]);
  });

  it('accepts every status label as vocabulary', () => {
    assert.equal(entry('- 상태: 폐기된 자료').declaredStatus, 'deprecated');
    assert.equal(normalizeStatus('미확인 자료'), 'unverified');
    assert.equal(normalizeStatus('코드에서 관찰한 동작'), 'observed_behavior');
    assert.equal(normalizeStatus('확정 정책'), 'confirmed_policy');
    assert.equal(normalizeStatus('검증된 경험'), 'verified_experience');
    assert.equal(normalizeStatus('충돌'), null);
  });
});

describe('field line exclusions', () => {
  const statusOf = (lines: string[]) => build(lines.join('\n')).items[0]!;

  it('ignores fields in multi-line HTML comments but keeps the text', () => {
    const item = statusOf(['## C', '본문', '<!--', '- 상태: 확정', '- 근거: docs/e.md', '- 구분: 필수', '-->']);
    assert.equal(item.declaredStatusRaw, null);
    assert.deepEqual(item.basisRefs, []);
    assert.equal(item.mandatory, false);
    assert.ok(item.content.includes('- 상태: 확정'));
  });

  it('does not let a commented value join the real one', () => {
    assert.equal(statusOf(['## C', '- 상태: 폐기', '<!-- 확정 전', '- 상태: 확정', '-->']).declaredStatus, 'deprecated');
    assert.equal(statusOf(['## C', '<!-- - 상태: 확정 -->', '본문']).declaredStatusRaw, null);
  });

  it('ignores fields in indented code blocks but keeps the text', () => {
    const item = statusOf(['## I', '예시', '', '    - 상태: 확정', '    - 근거: docs/e.md']);
    assert.equal(item.declaredStatusRaw, null);
    assert.deepEqual(item.basisRefs, []);
    assert.ok(item.content.includes('    - 상태: 확정'));
  });

  for (const [name, lines] of [
    ['a tab', ['## I', '예시', '', '\t- 상태: 확정']],
    ['a run after a blank inside code', ['## I', '', '    x', '', '    - 상태: 확정']],
    ['the first body line', ['## I', '    - 상태: 확정']],
    ['a fence close', ['## I', '```', '```', '    - 상태: 확정']],
    ['a one-line comment', ['## I', '<!-- 주석 -->', '    - 상태: 확정']],
    ['a paragraph that ended the list', ['## I', '- 메모', '끝', '', '    - 상태: 확정']],
  ] as const) {
    it(`treats an indented line after ${name} as code`, () => assert.equal(statusOf([...lines]).declaredStatusRaw, null));
  }

  it('keeps reading fields nested under a list item', () => {
    assert.equal(statusOf(['## L', '- 메모', '    - 상태: 확정']).declaredStatusRaw, '확정');
    assert.equal(statusOf(['## L', '- 메모', '', '    - 상태: 확정']).declaredStatusRaw, '확정');
    assert.equal(statusOf(['## L', '1. 메모', '\t- 상태: 확정']).declaredStatusRaw, '확정');
  });

  it('reads an indented line that continues a paragraph', () => {
    assert.equal(statusOf(['## L', '문단', '    - 상태: 확정']).declaredStatusRaw, '확정');
  });

  it('tracks raw HTML blocks like fences for headings and fields', () => {
    assert.deepEqual(shape(build(['# 설치', '<pre>', '# apt 패키지', '</pre>', '본문'].join('\n')).items), [['설치', 'section', 1, 5]]);
    for (const tag of ['script', 'style', 'textarea', 'PRE']) {
      const doc = ['## H', `<${tag}>`, '# 아님', '- 상태: 확정', `</${tag}>`, '## 진짜', '본문'].join('\n');
      const { items } = build(doc);
      assert.deepEqual(items.map((item) => item.anchor), ['h', '진짜'], tag);
      assert.equal(items[0]!.declaredStatusRaw, null, tag);
    }
  });

  it('closes a raw HTML block on its own line or at the end of the file', () => {
    assert.deepEqual(build(['<pre>한 줄</pre>', '## 진짜', '본문'].join('\n')).items.map((item) => item.anchor), ['_intro', '진짜']);
    assert.deepEqual(build(['## H', '<pre>', '## 아님'].join('\n')).items.map((item) => item.anchor), ['h']);
    assert.deepEqual(build(['## H', '<prefix>', '## 진짜', '글'].join('\n')).items.map((item) => item.anchor), ['h', '진짜']);
  });
});

describe('informal status notation', () => {
  const withFrontmatter = (...body: string[]) => build(['---', 'status: 확정', 'status_basis: docs/a.md', '---', '## H', ...body].join('\n'));
  const codes = (result: ReturnType<typeof build>) => result.diagnostics.map((d) => d.code);

  it('uses a demoting plain line or table row as the declared status', () => {
    for (const line of ['상태: 폐기', '**상태**: 폐기', '**상태:** 폐기', '| 상태 | 폐기 |', '| status | deprecated |']) {
      const result = withFrontmatter(line, '본문');
      assert.equal(result.items[0]!.declaredStatus, 'deprecated', line);
      assert.deepEqual(codes(result), ['unrecognized-status-field'], line);
    }
    assert.equal(withFrontmatter('상태: 미확인').items[0]!.declaredStatus, 'unverified');
    assert.equal(withFrontmatter('상태: 관찰').items[0]!.declaredStatus, 'observed_behavior');
  });

  it('cannot raise a status', () => {
    for (const line of ['상태: 확정', '| 상태 | 검증됨 |']) {
      const result = build(['## H', line, '본문'].join('\n'));
      assert.equal(result.items[0]!.declaredStatusRaw, null, line);
      assert.deepEqual(codes(result), ['unrecognized-status-field'], line);
    }
  });

  it('ignores values outside the vocabulary without a diagnostic', () => {
    for (const line of ['| 상태 | 설명 |', '상태: 결제 완료 후 변경', '- a | 상태: 폐기']) {
      const result = withFrontmatter(line, '본문');
      assert.equal(result.items[0]!.declaredStatus, 'confirmed_policy', line);
      assert.deepEqual(codes(result), [], line);
    }
  });

  it('never overrides a formal status but still warns', () => {
    const result = withFrontmatter('- 상태: 관찰', '상태: 폐기', '본문');
    assert.equal(result.items[0]!.declaredStatus, 'observed_behavior');
    assert.deepEqual(codes(result), ['unrecognized-status-field']);
  });

  it('takes the lowest of several informal values', () => {
    assert.equal(withFrontmatter('상태: 관찰', '| 상태 | 폐기 |').items[0]!.declaredStatus, 'deprecated');
  });

  it('applies intro fields to the intro only', () => {
    const { items } = build(['- 상태: 폐기', '', '# H', '본문'].join('\n'));
    assert.equal(items[0]!.declaredStatus, 'deprecated');
    assert.equal(items[1]!.declaredStatusRaw, null);
  });
});

describe('frontmatter recognition', () => {
  it('indexes a leading thematic break region as body', () => {
    const doc = ['---', '# 첫 절 제목', '첫 절 본문', '---', '# 둘째 절', '둘째 본문'].join('\n');
    const { items, diagnostics } = build(doc);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(shape(items), [['첫-절-제목', 'section', 2, 4], ['둘째-절', 'section', 5, 6]]);
  });

  it('indexes a mapping without a recognised key as body', () => {
    const { items, diagnostics } = build(['---', '# 환불 한도', '한도: 100만원', '기한: 3일', '---', '# 다음', '본문'].join('\n'));
    assert.deepEqual(diagnostics, []);
    assert.ok(items[0]!.content.includes('한도: 100만원'));
    assert.deepEqual(items.map((item) => item.startLine), [2, 6]);
  });

  it('keeps treating a mapping with one recognised key as frontmatter', () => {
    const { items } = build(['---', 'fixture: true', 'owner: 나', '---', '# H', '본문'].join('\n'));
    assert.deepEqual(shape(items), [['h', 'section', 5, 6]]);
  });

  it('keeps an empty region out of the body', () => {
    assert.deepEqual(build(['---', '---', '# H', '본문'].join('\n')).items.map((item) => item.startLine), [3]);
    assert.deepEqual(build('---\n---\n').items, []);
  });

  it('salvages status and basis when another key has the wrong type', () => {
    const { items, diagnostics } = build(['---', 'title: [1]', 'status: 폐기', 'status_basis: [docs/a.md]', '---', '# H', '본문'].join('\n'));
    assert.deepEqual(diagnostics.map((d) => d.code), ['invalid-frontmatter']);
    assert.equal(items[0]!.declaredStatus, 'deprecated');
    assert.deepEqual(items[0]!.basisRefs, [{ kind: 'path', value: 'docs/a.md' }]);
  });

  it('does not salvage a status of the wrong type', () => {
    const { items, diagnostics } = build(['---', 'status: 1', 'status_basis: 2', '---', '# H', '본문'].join('\n'));
    assert.deepEqual(diagnostics.map((d) => d.code), ['invalid-frontmatter']);
    assert.equal(items[0]!.declaredStatusRaw, null);
    assert.deepEqual(items[0]!.basisRefs, []);
  });
});

describe('inheritance', () => {
  const FM = ['---', 'status: 확정', 'status_basis: docs/doc.md', '---'];
  const named = (lines: string[]) => new Map(build(lines.join('\n')).items.map((item) => [item.anchor, item]));

  it('passes the nearest declared status down to subsections', () => {
    const items = named([...FM, '## 구', '- 상태: 폐기', '### 하위', '본문', '### 또 하위', '본문']);
    assert.equal(items.get('하위')!.declaredStatus, 'deprecated');
    assert.equal(items.get('또-하위')!.declaredStatus, 'deprecated');
  });

  it('skips the basis of a layer that declares a different status', () => {
    assert.deepEqual(named([...FM, '## 구', '- 상태: 폐기', '### 하위', '본문']).get('하위')!.basisRefs, []);
    const items = named(['## A', '- 상태: 폐기', '- 근거: docs/old.md', '### B', '- 상태: 확정', '#### C', '본문']);
    assert.equal(items.get('c')!.declaredStatus, 'confirmed_policy');
    assert.deepEqual(items.get('c')!.basisRefs, []);
  });

  it('uses the basis of the declaring layer, then of agreeing layers above it', () => {
    assert.deepEqual(named([...FM, '## 부모', '- 상태: 확정', '### 자식', '본문']).get('자식')!.basisRefs, [{ kind: 'path', value: 'docs/doc.md' }]);
    assert.deepEqual(named([...FM, '## 부모', '- 상태: 확정', '- 근거: docs/p.md', '### 자식', '본문']).get('자식')!.basisRefs, [{ kind: 'path', value: 'docs/p.md' }]);
    assert.deepEqual(named([...FM, '## 부모', '- 근거: docs/p.md', '### 자식', '- 상태: 확정', '본문']).get('자식')!.basisRefs, [{ kind: 'path', value: 'docs/p.md' }]);
  });

  it('prefers the nearest ancestor over farther ones', () => {
    const items = named(['## A', '- 상태: 폐기', '### B', '- 상태: 확정', '- 근거: docs/b.md', '#### C', '본문']);
    assert.equal(items.get('c')!.declaredStatus, 'confirmed_policy');
    assert.deepEqual(items.get('c')!.basisRefs, [{ kind: 'path', value: 'docs/b.md' }]);
  });

  it('backs an inherited status with a basis below the declaring layer', () => {
    assert.deepEqual(named([...FM.slice(0, 2), '---', '## A', '- 근거: docs/a.md', '본문']).get('a')!.basisRefs, [{ kind: 'path', value: 'docs/a.md' }]);
  });

  it('prefers the nearest usable basis starting from the item itself', () => {
    const items = named([...FM, '## A', '- 근거: docs/a.md', '### B', '- 근거: docs/b.md', '#### C', '본문']);
    assert.deepEqual(items.get('b')!.basisRefs, [{ kind: 'path', value: 'docs/b.md' }]);
    assert.deepEqual(items.get('c')!.basisRefs, [{ kind: 'path', value: 'docs/b.md' }]);
  });

  it('uses the basis of an undeclared layer below an ancestor that declares the status', () => {
    const items = named(['## A', '- 상태: 폐기', '### B', '- 근거: docs/b.md', '본문']);
    assert.equal(items.get('b')!.declaredStatus, 'deprecated');
    assert.deepEqual(items.get('b')!.basisRefs, [{ kind: 'path', value: 'docs/b.md' }]);
  });

  it('skips only the layers that declare a different status while walking up', () => {
    const items = named(['## A', '- 상태: 확정', '- 근거: docs/a.md', '### B', '- 상태: 폐기', '- 근거: docs/b.md', '#### C', '- 상태: 확정', '본문']);
    assert.equal(items.get('c')!.declaredStatus, 'confirmed_policy');
    assert.deepEqual(items.get('c')!.basisRefs, [{ kind: 'path', value: 'docs/a.md' }]);
  });

  it('uses the nearest basis when no layer declares a status', () => {
    const items = named(['## A', '- 근거: docs/a.md', '### B', '본문']);
    assert.equal(items.get('b')!.declaredStatusRaw, null);
    assert.deepEqual(items.get('b')!.basisRefs, [{ kind: 'path', value: 'docs/a.md' }]);
  });

  it('counts informal notation as a declaration in the chain', () => {
    assert.equal(named([...FM, '## A', '상태: 폐기', '### B', '본문']).get('b')!.declaredStatus, 'deprecated');
  });

  it('leaves the document intro out of the chain', () => {
    assert.equal(named(['- 상태: 폐기', '- 구분: 필수', '', '# H', '본문']).get('h')!.declaredStatusRaw, null);
    assert.equal(named(['- 상태: 폐기', '- 구분: 필수', '', '# H', '본문']).get('h')!.mandatory, false);
  });

  it('inherits through an ancestor heading that has no item of its own', () => {
    const items = named(['## A', '- 상태: 폐기', '### 빈', '#### 깊은', '본문']);
    assert.equal(items.get('깊은')!.declaredStatus, 'deprecated');
    assert.equal(named(['## A', '- 상태: 폐기', '### `K`', '본문']).get('K')!.declaredStatus, 'deprecated');
  });

  it('inherits conflicts but no other relation', () => {
    const child = named(['## A', '- 충돌: `X`', '- 의존: `D`', '- 코드: src/a.ts', '- 계약: `CON-1`', '### B', '본문']).get('b')!;
    assert.deepEqual(child.relations, { conflicts_with: ['X'] });
    assert.deepEqual(named(['## A', '- 충돌: `X`', '### B', '- 충돌: `Y`']).get('b')!.relations.conflicts_with, ['X', 'Y']);
  });

  it('inherits mandatory from any ancestor section', () => {
    assert.equal(named(['## A', '- 구분: 필수', '### B', '#### C', '본문']).get('c')!.mandatory, true);
    assert.equal(named(['## A', '본문', '### B', '본문']).get('b')!.mandatory, false);
  });
});

describe('keyed entries without a body', () => {
  it('keeps the entry and still drops plain heading-only sections', () => {
    const { items } = build(['## 빈', '', '### `K` 제목', '', '### `L`', '본문'].join('\n'));
    assert.deepEqual(shape(items), [['K', 'entry', 3, 3], ['L', 'entry', 5, 6]]);
    assert.equal(items[0]!.content, '### `K` 제목');
    assert.equal(items[0]!.title, '제목');
  });
});

describe('multi-line and short setext headings', () => {
  it('uses the whole preceding paragraph as the heading', () => {
    const doc = ['첫째 줄', '둘째 줄', '===', '', '본문'].join('\n');
    const { items } = build(doc);
    assert.deepEqual(shape(items), [['첫째-줄-둘째-줄', 'section', 1, 5]]);
    assert.equal(items[0]!.title, '첫째 줄 둘째 줄');
    assertExactRanges(doc, items);
  });

  it('accepts one = and two or more -, but not a lone -', () => {
    assert.deepEqual(build(['제목 하나', '=', '본문'].join('\n')).items.map((item) => item.anchor), ['제목-하나']);
    assert.deepEqual(build(['제목 둘', '--', '본문'].join('\n')).items.map((item) => item.anchor), ['제목-둘']);
    assert.deepEqual(build(['제목 셋', '-', '본문'].join('\n')).items.map((item) => item.unit), ['document']);
  });

  it('treats text after a list line as a lazy continuation, not a heading', () => {
    assert.deepEqual(shape(build(['- 항목', '제목', '===', '본문'].join('\n')).items), [['_intro', 'document', 1, 4]]);
  });

  it('starts a new paragraph once a blank line ends the list or quote', () => {
    assert.deepEqual(shape(build(['- 항목', '', '제목', '===', '본문'].join('\n')).items), [['_intro', 'document', 1, 1], ['제목', 'section', 3, 5]]);
    assert.deepEqual(shape(build(['> 인용', '', '제목', '---', '본문'].join('\n')).items), [['_intro', 'document', 1, 1], ['제목', 'section', 3, 5]]);
    assert.deepEqual(shape(build(['> 인용', '>', '제목', '---', '본문'].join('\n')).items), [['_intro', 'document', 1, 2], ['제목', 'section', 3, 5]]);
  });
});

describe('dash underlines without a body', () => {
  it('keeps a whole paragraph in the previous section when the next heading follows', () => {
    const doc = ['# 제목', '', '## 섹션', '', '첫째 줄 설명 환불규칙', '둘째 줄 설명 정산주기', '셋째 줄 설명 수수료', '---', '', '## 다음', '', '다른 본문입니다.'].join('\n');
    const { items } = build(doc);
    assert.deepEqual(shape(items), [['섹션', 'section', 3, 8], ['다음', 'section', 10, 12]]);
    assert.ok(items[0]!.content.includes('환불규칙'));
    assert.ok(items[0]!.content.includes('정산주기'));
    assertExactRanges(doc, items);
  });

  it('treats the underline as a thematic break at the end of the file', () => {
    assert.deepEqual(shape(build(['## 앞', '본문', '', '문단', '---', ''].join('\n')).items), [['앞', 'section', 1, 5]]);
  });

  it('keeps the paragraph as a document item when no section precedes it', () => {
    assert.deepEqual(shape(build(['문단', '---', '', '## 다음', '글'].join('\n')).items), [['_intro', 'document', 1, 2], ['다음', 'section', 4, 5]]);
  });

  it('keeps reading the status of the section across the break', () => {
    const items = build(['## 정책', '- 상태: 폐기', '', '설명 문단입니다.', '---', '', '## 다음', '글'].join('\n')).items;
    assert.deepEqual(shape(items), [['정책', 'section', 1, 5], ['다음', 'section', 7, 8]]);
    assert.equal(items[0]!.declaredStatus, 'deprecated');
  });

  it('gives an earlier heading its body when a later underline turns out to be a break', () => {
    const { items } = build(['가', '---', '나', '---'].join('\n'));
    assert.deepEqual(shape(items), [['가', 'section', 1, 4]]);
    assert.equal(items[0]!.content, '가\n---\n나\n---');
  });

  it('does not count another thematic break as body text', () => {
    assert.deepEqual(shape(build(['## 앞', '본문', '', '문단', '---', '', '---', '', '## 다음', '글'].join('\n')).items), [['앞', 'section', 1, 7], ['다음', 'section', 9, 10]]);
  });

  it('keeps the = underline as a heading even with a following heading', () => {
    const { items } = build(['첫째', '둘째', '=', '## 다음', '글'].join('\n'));
    assert.deepEqual(shape(items), [['첫째-둘째', 'section', 1, 3], ['다음', 'section', 4, 5]]);
    assert.equal(items[0]!.title, '첫째 둘째');
  });
});

describe('paragraphs continued from a list or quote', () => {
  const STATUS = ['- 상태: 확정', '- 근거: real.ts'];

  for (const [name, lines] of [
    ['an indented list continuation', [...STATUS, '  (자세한 내용은 별도 문서)']],
    ['a lazy list continuation', [...STATUS, '게으른 연속 줄']],
    ['a continuation of a numbered list', [...STATUS, '1) 항목', '   이어지는 줄']],
    ['a lazy blockquote line', [...STATUS, '> 인용문', '게으른 인용 연속']],
    ['a paragraph inside a list item', [...STATUS, '', '  목록 안 문단']],
  ] as const) {
    it(`does not make a heading out of ${name}`, () => {
      const doc = ['## 정책', '', ...lines, '---', '', '이어지는 설명 문단입니다.'].join('\n');
      const { items } = build(doc);
      assert.deepEqual(shape(items), [['정책', 'section', 1, doc.split('\n').length]]);
      assert.equal(items[0]!.declaredStatusRaw, '확정');
    });
  }

  it('still takes a heading from a paragraph after a closed quoted fence', () => {
    const { items } = build(['## A', '> ```', '> - 상태: 폐기', '> ```', '제목', '---', '본문'].join('\n'));
    assert.deepEqual(shape(items), [['a', 'section', 1, 4], ['제목', 'section', 5, 7]]);
  });

  it('does not continue a quote through a heading or rule inside it', () => {
    assert.deepEqual(shape(build(['> # 인용 제목', '제목', '---', '본문'].join('\n')).items), [['_intro', 'document', 1, 1], ['제목', 'section', 2, 4]]);
  });
});

describe('list and quote containers', () => {
  const only = (lines: string[]) => build(lines.join('\n')).items[0]!;
  const FENCED = ['```yaml', '- 상태: 폐기', '# 이것은 주석', '```'];
  const indent = (count: number, lines: readonly string[]) => lines.map((line) => ' '.repeat(count) + line);

  it('recognizes a fence at the content offset of a nested list', () => {
    const doc = ['## 예시', '', '- 항목', '  - 하위', '', ...indent(4, FENCED), '', '본문.'];
    const item = only(doc);
    assert.equal(item.declaredStatusRaw, null);
    assert.deepEqual(shape(build(doc.join('\n')).items), [['예시', 'section', 1, doc.length]]);
  });

  it('does not join code in a nested list to the real status', () => {
    const item = only(['## 정책', '- 상태: 확정', '', '- 항목', '  - 하위', '', ...indent(4, FENCED)]);
    assert.equal(item.declaredStatusRaw, '확정');
    assert.equal(item.declaredStatus, 'confirmed_policy');
  });

  for (const [name, body] of [
    ['an HTML comment', ['<!--', '- 상태: 폐기', '-->']],
    ['a raw HTML block', ['<pre>', '- 상태: 폐기', '</pre>']],
    ['a fence', ['```', '- 상태: 폐기', '```']],
  ] as const) {
    it(`recognizes ${name} inside a list by its content offset`, () => {
      assert.equal(only(['## 예시', '- 항목', '  - 하위', '', ...indent(4, body), '', '본문.']).declaredStatusRaw, null);
      assert.equal(only(['## 예시', '1. 항목', '', ...indent(4, body), '', '본문.']).declaredStatusRaw, null);
    });

    it(`recognizes ${name} right after a list marker`, () => {
      const [first, ...rest] = body;
      assert.equal(only(['## 예시', `- ${first}`, ...indent(2, rest)]).declaredStatusRaw, null);
      assert.equal(only(['## 예시', `1. ${first}`, ...indent(3, rest)]).declaredStatusRaw, null);
    });
  }

  it('closes a fence opened on a numbered list marker and keeps later headings', () => {
    const doc = ['## 설치', '', '1. ```bash', '   npm ci', '   ```', '2. 다음 단계', '', '## 운영', '', '운영 본문.'];
    assert.deepEqual(shape(build(doc.join('\n')).items), [['설치', 'section', 1, 6], ['운영', 'section', 8, 10]]);
  });

  it('closes a fence opened on a bullet marker and reads the fields after it', () => {
    const { items } = build(['## 예시', '- ```yaml', '  - 상태: 폐기', '  ```', '- 상태: 확정', '', '## 다음', '글'].join('\n'));
    assert.deepEqual(items.map((item) => item.anchor), ['예시', '다음']);
    assert.equal(items[0]!.declaredStatusRaw, '확정');
  });

  it('accepts the closing fence within three columns of the content offset', () => {
    const { items } = build(['- 항목', '', '    ```', '    ## 안', '       ```', '## 밖', '글'].join('\n'));
    assert.deepEqual(items.map((item) => item.anchor), ['_intro', '밖']);
  });

  it('does not take a fence four columns past the content offset for an opener or closer', () => {
    assert.deepEqual(build(['## L', '- 항목', '      ```', '  ## 진짜', '본문'].join('\n')).items.map((item) => item.anchor), ['l', '진짜']);
    assert.deepEqual(build(['- ```', '  코드', '      ```', '  ```', '  ## 진짜', '본문'].join('\n')).items.map((item) => item.anchor), ['_intro', '진짜']);
  });

  it('counts only one column after a marker followed by five or more spaces', () => {
    assert.equal(only(['## L', '-      ```', '       - 상태: 확정']).declaredStatusRaw, '확정');
  });

  it('keeps the list open across a quote nested inside it', () => {
    assert.equal(only(['## L', '- 메모', '  > 인용', '', '    - 상태: 확정']).declaredStatusRaw, '확정');
  });

  it('does not open a list from a thematic break', () => {
    assert.equal(only(['## L', '* * *', '', '      - 상태: 폐기']).declaredStatusRaw, null);
  });

  it('ends a list fence with its list item', () => {
    assert.deepEqual(shape(build(['## A', '- ```', '  코드', '본문 밖', '', '## 진짜', '글'].join('\n')).items), [['a', 'section', 1, 4], ['진짜', 'section', 6, 7]]);
  });

  it('ends a quoted fence at the first line without the prefix', () => {
    assert.deepEqual(shape(build(['> ```', '> 코드', '## 진짜', '글'].join('\n')).items), [['_intro', 'document', 1, 2], ['진짜', 'section', 3, 4]]);
  });

  it('closes a quoted fence on a quoted closing marker', () => {
    assert.deepEqual(shape(build(['> ```', '> 코드', '> ```', '> 계속', '', '## 진짜', '글'].join('\n')).items), [['_intro', 'document', 1, 4], ['진짜', 'section', 6, 7]]);
  });

  it('treats content offset plus four columns after a blank line as code', () => {
    assert.equal(only(['## 예시', '- 코드 예:', '', '      - 상태: 폐기', '', '본문.']).declaredStatusRaw, null);
    assert.equal(only(['## 예시', '1. 코드 예:', '', '       - 상태: 폐기']).declaredStatusRaw, null);
    assert.equal(only(['## 예시', '- 항목', '  - 하위', '', '        - 상태: 폐기']).declaredStatusRaw, null);
  });

  it('keeps reading deeply indented fields that follow the list item directly', () => {
    assert.equal(only(['## L', '- 메모', '        - 상태: 확정']).declaredStatusRaw, '확정');
    assert.equal(only(['## L', '- 메모', '  - 하위', '    - 상태: 확정']).declaredStatusRaw, '확정');
  });

  it('pops a list once a line is indented less than its content', () => {
    assert.equal(only(['## L', '- 메모', '끝', '', '  - 상태: 확정']).declaredStatusRaw, '확정');
    assert.equal(only(['## L', '- 메모', '', '끝', '', '    - 상태: 폐기']).declaredStatusRaw, null);
  });

  it('does not read a numbered list line as a field', () => {
    assert.equal(only(['## L', '1. 상태: 폐기', '본문']).declaredStatusRaw, null);
  });

  it('keeps recognizing ATX headings regardless of list containers', () => {
    assert.deepEqual(shape(build(['- 항목', '  ## 제목', '본문'].join('\n')).items), [['_intro', 'document', 1, 1], ['제목', 'section', 2, 3]]);
  });

  it('forgets list containers at a heading', () => {
    const { items } = build(['- 항목', '  ## B', '    - 상태: 폐기'].join('\n'));
    assert.deepEqual(items.map((item) => item.anchor), ['_intro', 'b']);
    assert.equal(items[1]!.declaredStatusRaw, null);
  });
});

describe('documents without any section', () => {
  it('emits one document item when frontmatter carries an id', () => {
    const doc = ['---', 'id: POL-9', 'title: 문서', 'status: 확정', 'status_basis: real.ts', '---'].join('\n');
    const { items } = build(`${doc}\n`);
    assert.deepEqual(shape(items), [['_intro', 'document', 1, 6]]);
    assert.equal(items[0]!.key, 'POL-9');
    assert.equal(items[0]!.title, '문서');
    assert.equal(items[0]!.content, doc);
    assert.equal(items[0]!.declaredStatus, 'confirmed_policy');
    assert.deepEqual(items[0]!.basisRefs, [{ kind: 'path', value: 'real.ts' }]);
    assertExactRanges(doc, items);
  });

  it('emits one document item when frontmatter carries a status', () => {
    const { items } = build(['---', 'status: 폐기', 'title: 옛 문서', '---'].join('\n'));
    assert.deepEqual(shape(items), [['_intro', 'document', 1, 4]]);
    assert.equal(items[0]!.declaredStatus, 'deprecated');
  });

  it('covers heading-only documents and salvaged status', () => {
    const headings = ['---', 'status: 폐기', '---', '## 제목', '', '### 더 깊은 제목'].join('\n');
    const { items } = build(headings);
    assert.deepEqual(shape(items), [['_intro', 'document', 1, 6]]);
    assert.equal(items[0]!.content, headings);
    assert.equal(build(['---', 'title: [1]', 'status: 폐기', '---'].join('\n')).items[0]!.declaredStatus, 'deprecated');
  });

  it('emits nothing without an id or status and leaves documents with items alone', () => {
    assert.deepEqual(build(['---', 'title: x', '---', '## 제목'].join('\n')).items, []);
    assert.deepEqual(build(['---', 'id: A', '---', '## 제목', '글'].join('\n')).items.map((item) => item.unit), ['section']);
  });
});

describe('none markers on conflicts and dependencies', () => {
  const entry = (...fields: string[]) => build(['### `K` 제목', ...fields].join('\n')).items[0]!;

  for (const none of [
    '없음.', '없음。', '없음!', '해당 없음', '해당없음', '해당 사항 없음', '해당사항없음', '해당 없습니다', '해당없습니다.', '없습니다', '없습니다.', '없다',
    'NONE', 'None.', 'n / a', 'N/A.', 'NA', 'nil', 'NULL', '—', '없음 (검토 완료)', '없음, 추후 검토', '없음(검토 완료)', '해당 없음 — 별도 문서', 'none (tbd)',
  ]) {
    it(`reads "${none}" as none`, () => {
      assert.equal(entry(`- 충돌: ${none}`).relations.conflicts_with, undefined);
      assert.equal(entry(`- 의존: ${none}`).relations.dependency, undefined);
    });
  }

  for (const value of ['없음에도 충돌', '없다고 본다', '해당 사항 있음', 'na-service', 'none.example.com', 'nullable 설정', 'nil/legacy', '-foo', 'NA 리전 정책', '없음 처리 규칙과 상충', 'null 처리 규칙과 충돌']) {
    it(`keeps "${value}" as a declared target`, () => {
      assert.deepEqual(entry(`- 충돌: ${value}`).relations.conflicts_with, [value]);
      assert.deepEqual(entry(`- 의존: ${value}`).relations.dependency, [value]);
    });
  }
});

describe('intros without content', () => {
  for (const [name, intro] of [['a comment', ['<!-- markdownlint-disable MD013 -->']], ['a multi-line comment', ['<!--', '설명', '-->']], ['a horizontal rule', ['---']]] as const) {
    it(`gives the frontmatter id to the first section after ${name}`, () => {
      const { items } = build(['---', 'id: POL-1', 'aliases: [별명]', '---', ...intro, '', '# 정책', '본문'].join('\n'));
      assert.deepEqual(items.map((item) => [item.anchor, item.key]), [['정책', 'POL-1']]);
      assert.ok(items[0]!.aliases.includes('별명'));
    });
  }

  it('keeps an intro that has text next to a comment', () => {
    const { items } = build(['---', 'id: POL-1', '---', '<!-- 메모 -->', '안내 문장', '', '# 정책', '본문'].join('\n'));
    assert.deepEqual(items.map((item) => [item.anchor, item.key]), [['_intro', 'POL-1'], ['정책', null]]);
  });

  it('keeps an intro holding a code block', () => {
    assert.deepEqual(build(['```', '코드', '```', '', '# 정책', '본문'].join('\n')).items.map((item) => item.anchor), ['_intro', '정책']);
  });
});

describe('table header rows', () => {
  const codes = (result: ReturnType<typeof build>) => result.diagnostics.map((d) => d.code);

  for (const [name, delimiter] of [['plain', '|---|---|'], ['spaced and aligned', '| :--- | ---: |']] as const) {
    it(`does not read a header row above a ${name} delimiter as a status`, () => {
      const result = build(['## 표', '', '| status | deprecated |', delimiter, '| a | b |'].join('\n'));
      assert.equal(result.items[0]!.declaredStatusRaw, null);
      assert.deepEqual(codes(result), []);
    });
  }

  it('still reads a status row in the table body', () => {
    const result = build(['## 표', '| 이름 | 값 |', '|---|---|', '| 상태 | 폐기 |'].join('\n'));
    assert.equal(result.items[0]!.declaredStatus, 'deprecated');
    assert.deepEqual(codes(result), ['unrecognized-status-field']);
  });

  it('does not take a thematic break for a delimiter row', () => {
    assert.equal(build(['## 표', '상태: 폐기', '---', '', '## 다음', '글'].join('\n')).items[0]!.declaredStatus, 'deprecated');
  });
});

describe('backticked basis tokens', () => {
  const basis = (value: string) => build(['### `K`', `- 근거: ${value}`].join('\n')).items[0]!.basisRefs;

  it('keeps a backticked path with spaces as one reference', () => {
    assert.deepEqual(basis('`a b.ts`'), [{ kind: 'path', value: 'a b.ts' }]);
    assert.deepEqual(basis('`path:a b.ts`'), [{ kind: 'path', value: 'a b.ts' }]);
  });

  it('mixes backticked and bare tokens', () => {
    assert.deepEqual(basis('`a b.ts`, src/c.ts'), [{ kind: 'path', value: 'a b.ts' }, { kind: 'path', value: 'src/c.ts' }]);
  });

  it('still keeps a value with prose as one opaque reference', () => {
    assert.deepEqual(basis('`a b.ts` 참고'), [{ kind: 'opaque', value: 'a b.ts 참고' }]);
  });
});

describe('pathological lines', () => {
  const quick = (name: string, text: string) => {
    const started = performance.now();
    build(text);
    assert.ok(performance.now() - started < 1000, name);
  };

  for (const [name, text] of [
    ['a list marker with a long space run', `- ${' '.repeat(100000)}x`],
    ['a field name followed by spaces', `- 상태${' '.repeat(100000)}x`],
    ['an ATX heading with an inner space run', `# a${' '.repeat(100000)}b`],
    ['an ATX heading with trailing spaces', `# a${' '.repeat(100000)}`],
    ['a plain line with a long space run', `상태${' '.repeat(100000)}x`],
    ['a line of nested list markers', `${'- '.repeat(50000)}x`],
    ['a line of nested quote markers', `${'> '.repeat(50000)}x`],
    ['a table row followed by a long delimiter', `| 상태 | 폐기 |\n|${'-|'.repeat(50000)}`],
    ['a long none-like value', `- 충돌: n${' '.repeat(100000)}x`],
  ] as const) {
    it(`parses ${name} within a second`, () => quick(name, text));
  }

  it('assigns many duplicate anchors in linear time', () => {
    const text = Array.from({ length: 20000 }, () => '## 같은 제목\n글').join('\n');
    const started = performance.now();
    const { items } = build(text);
    assert.ok(performance.now() - started < 2000);
    assert.equal(new Set(items.map((item) => item.anchor)).size, items.length);
    assert.equal(items.at(-1)!.anchor, '같은-제목-19999');
  });

  it('still strips closing hashes', () => {
    assert.deepEqual(build(['## 닫힘  ##  ', '글', '## a#', '글', '## ##', '글'].join('\n')).items.map((item) => item.title), ['닫힘', 'a#', '']);
  });
});

describe('precedence', () => {
  const fm = ['---', 'kind: policy', 'status: 미확인', 'status_basis: docs/doc.md', 'relations: {policy: POL-A, code: [./src/m.ts:9], related: [x y]}', 'applies_to: {paths: [src/], phases: [test, nope], conditions: 문서 조건}', '---'];

  it('prefers item fields for kind, status and basis', () => {
    const item = build([...fm, '### `K`', '- 종류: flow', '- 상태: 확정', '- 근거: docs/item.md'].join('\n'), { rule: { match: '**', kind: 'plan' } }).items[0]!;
    assert.equal(item.kind, 'flow');
    assert.equal(item.declaredStatus, 'confirmed_policy');
    assert.deepEqual(item.basisRefs, [{ kind: 'path', value: 'docs/item.md' }]);
  });

  it('falls back through frontmatter, rule, default and reference', () => {
    const body = '## H\n글';
    assert.equal(build(['---', 'kind: policy', '---', body].join('\n'), { rule: { match: '**', kind: 'plan' } }).items[0]!.kind, 'policy');
    assert.equal(build(body, { rule: { match: '**', kind: 'plan' }, defaultKind: 'flow' }).items[0]!.kind, 'plan');
    assert.equal(build(body, { defaultKind: 'flow' }).items[0]!.kind, 'flow');
    assert.equal(build(body, { defaultKind: undefined }).items[0]!.kind, 'reference');
  });

  it('ignores an invalid item kind with a diagnostic', () => {
    const { items, diagnostics } = build('## H\n- 종류: 없는종류', { defaultKind: 'flow' });
    assert.equal(items[0]!.kind, 'flow');
    assert.deepEqual(diagnostics.map((d) => d.code), ['unknown-kind']);
  });

  it('merges relations and takes applicability from the item when it scopes itself', () => {
    const inherited = build([...fm, '## H', '- 정책: POL-B'].join('\n')).items[0]!;
    assert.deepEqual(inherited.relations, { policy: ['POL-A', 'POL-B'], code: ['src/m.ts'], related: ['x y'] });
    assert.deepEqual(inherited.appliesTo, { global: false, paths: ['src/'], phases: ['test'], conditions: '문서 조건' });
    const scoped = build([...fm, '## H', '- 범위: 전체', '- 단계: review'].join('\n')).items[0]!;
    assert.deepEqual(scoped.appliesTo, { global: true, paths: [], phases: ['review'], conditions: '문서 조건' });
  });

  it('ORs mandatory across item, frontmatter and rule and keeps the rule', () => {
    const rule = { match: '**', mandatory: true };
    const item = build('## H\n글', { rule }).items[0]!;
    assert.equal(item.mandatory, true);
    assert.deepEqual(item.rule, rule);
    assert.equal(build(['---', 'mandatory: true', '---', '## H\n글'].join('\n')).items[0]!.mandatory, true);
    assert.equal(build('## H\n글').items[0]!.mandatory, false);
  });
});

describe('tokenizer', () => {
  it('emits camelCase and Hangul boundary pieces', () => {
    assert.deepEqual(wordsOf('retryPolicy'), ['retrypolicy', 'retry', 'policy']);
    assert.deepEqual(wordsOf('주문API'), ['주문api', '주문', 'api']);
    assert.deepEqual(wordsOf('HTTPServer v2Api'), ['httpserver', 'http', 'server', 'v2api', 'v2', 'api']);
  });

  it('keeps a base token adjacent when a particle follows a non-Hangul run', () => {
    assert.deepEqual(wordsOf('ORD-18을'), ['ord', '18', '을']);
    assert.deepEqual(wordsOf('order-service의'), ['order', 'service', '의']);
    assert.deepEqual(wordsOf('주문API를'), ['주문api를', '주문', 'api', '를']);
  });

  it('treats a non-Hangul head like a normal run before its Hangul tail', () => {
    assert.deepEqual(wordsOf('retryPolicy를'), ['retrypolicy', 'retry', 'policy', '를']);
    assert.deepEqual(wordsOf('getUserName에서'), ['getusername', 'get', 'user', 'name', '에서']);
    assert.deepEqual(wordsOf('ORD-18A를'), ['ord', '18a', '18', 'a', '를']);
    assert.deepEqual(wordsOf('API를'), ['api', '를']);
  });

  it('splits on punctuation, keeps underscores and composes NFC', () => {
    assert.deepEqual(wordsOf('BR-001 snake_case'), ['br', '001', 'snake_case']);
    assert.deepEqual(wordsOf('주문'.normalize('NFD')), ['주문']);
  });

  it('emits Hangul bigrams with a sentinel between runs', () => {
    assert.deepEqual(hangulBigrams('주문취소 API 가 환불'), ['주문', '문취', '취소', 'zzsep', '환불']);
    assert.deepEqual(hangulBigrams('a 가'), []);
  });

  it('builds index columns', () => {
    assert.deepEqual(indexColumns({ key: 'BR-001', aliases: ['취소규칙'], title: '주문 취소', headingPath: ['규칙', 'retryPolicy'], content: '본문 내용' }), {
      key_aliases: 'br 001 취소규칙',
      title: '주문 취소',
      headings: '규칙 retrypolicy retry policy',
      body: '본문 내용',
      ngram_title: '주문 zzsep 취소 zzsep 규칙',
      ngram_body: '본문 zzsep 내용',
    });
  });
});
