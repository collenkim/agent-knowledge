import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../src/cli/args.js';
import { EXIT_CODES } from '../src/index.js';
import { tempSpace } from './helpers.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const REQUIRED_DOCUMENTS = ['AGENTS.md', 'README.md', 'docs/integration.md', 'docs/knowledge-model.md', 'docs/retrieval.md', 'docs/scope.md', 'knowledge/README.md', 'knowledge/responsibilities.md'];
const INLINE_LINK = /\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_LINK = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

function markdownFiles(root: string): string[] {
  const inside = (dir: string): string[] => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((name) => name.endsWith('.md')).map((name) => `${dir}/${name}`) : []);
  return [...['README.md', 'AGENTS.md'].filter((name) => existsSync(join(root, name))), ...inside('docs'), ...inside('knowledge')].sort();
}

/** 코드 예시 안의 대괄호·괄호는 링크가 아니다. */
function withoutCode(text: string): string {
  let fence: string | null = null;
  const prose = text.split(/\r?\n/).map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    if (marker) {
      fence = marker;
      return '';
    }
    return line;
  });
  // 짝이 맞지 않는 백틱이 여러 줄을 지워 끊어진 링크를 숨기지 않도록 한 줄 안에서만 찾는다
  return prose.join('\n').replace(/(`+)[^\n]*?\1/g, '');
}

function brokenLinks(root: string, files: readonly string[]): string[] {
  return files.flatMap((file) => {
    const prose = withoutCode(readFileSync(join(root, file), 'utf8'));
    const targets = [...prose.matchAll(INLINE_LINK), ...prose.matchAll(REFERENCE_LINK)].map((match) => match[1]!.replace(/^<|>$/g, ''));
    return targets
      .filter((target) => !URL_SCHEME.test(target) && !target.startsWith('#'))
      .filter((target) => !existsSync(resolve(root, dirname(file), decodeURI(target.replace(/[#?].*$/, '')))))
      .map((target) => `${file} -> ${target}`);
  });
}

/** 표에서 첫 칸이 백틱 코드인 행을 코드 → 종료 코드로 읽는다. */
function exitTable(text: string): Map<string, number> {
  return new Map([...text.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|/gm)].map((match) => [match[1]!, Number(match[2])]));
}

/** 제목 줄 다음부터 같거나 높은 수준의 다음 제목 앞까지. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `missing heading: ${heading}`);
  const level = /^#+/.exec(heading)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => (/^(#+) /.exec(line)?.[1]?.length ?? Infinity) <= level);
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

const quotedKebab = (text: string): string[] => [...text.matchAll(/'([a-z0-9]+(?:-[a-z0-9]+)*)'/g)].map((match) => match[1]!);

describe('문서 일치', () => {
  const read = (path: string): string => readFileSync(join(PACKAGE_ROOT, path), 'utf8');
  const retrieval = (): string => read('docs/retrieval.md');
  const model = (): string => read('docs/knowledge-model.md');

  it('예시 설정과 README가 규칙의 상태 선언을 운영자 선언으로 경고한다', () => {
    const phrase = '운영자가 의도적으로 쓰는 선언';
    assert.ok(read('config/sources.example.yaml').includes(phrase));
    assert.ok(sectionOf(read('README.md'), '## 설정').includes(phrase));
  });

  it('validate 절이 원본 설정 실패와 검색 설정 실패를 구분한다', () => {
    const section = sectionOf(retrieval(), '### `validate`');
    assert.match(section, /원본 설정[^\n]*`agent-knowledge\.error`/);
    assert.match(section, /`retrieval\.ok: false`/);
    assert.match(section, /`retrieval\.error`/);
    assert.doesNotMatch(section, /설정 파일을 읽을 수 없으면/);
  });

  it('AGENTS.md가 문서 테스트의 범위를 부풀리지 않는다', () => {
    const claim = read('AGENTS.md').split(/\r?\n/).find((line) => line.includes('tests/docs.test.ts'));
    assert.ok(claim);
    assert.doesNotMatch(claim, /어긋나/);
    assert.match(claim, /종료 코드 값이 다를/);
    assert.match(claim, /대상 파일이 없을/);
  });

  it('코드의 문서 진단·건너뛴 이유·충돌 사유가 docs/knowledge-model.md에 있다', () => {
    const diagnostics = ['src/parsing/build-items.ts', 'src/parsing/frontmatter.ts'].flatMap((path) => [...read(path).matchAll(/code: '([a-z-]+)'/g)].map((match) => match[1]!));
    const skipReasons = quotedKebab(/type SkipReason = ([^;]+);/.exec(read('src/sources/collect.ts'))![1]!);
    const conflictReasons = quotedKebab(/reason: ('[^;]+');/.exec(read('src/indexing/resolve.ts'))![1]!);
    assert.ok(diagnostics.length > 0 && skipReasons.length > 0 && conflictReasons.length > 0);
    const text = model();
    for (const code of [...diagnostics, ...skipReasons, ...conflictReasons]) assert.ok(text.includes(`\`${code}\``), `missing code: ${code}`);
  });

  it('상태 판정의 핵심 규칙을 문서가 설명한다', () => {
    const text = model();
    for (const marker of ['### 선언의 상속', '### 비공식 표기', '### 대체', '들여쓰기 코드', '`<textarea>`', '`not-git-toplevel`', '`superseded`']) assert.ok(text.includes(marker), `missing: ${marker}`);
    assert.ok(retrieval().includes('`not-git-toplevel`'));
    assert.ok(read('README.md').includes('`not-git-toplevel`'));
    for (const marker of ['`unconfirmed-supersession`', '`gitChildEnv()`']) assert.ok(read('AGENTS.md').includes(marker), `missing: ${marker}`);
  });

  it('요구한 문서가 모두 검사 대상이다', () => {
    const files = markdownFiles(PACKAGE_ROOT);
    for (const document of REQUIRED_DOCUMENTS) assert.ok(files.includes(document), `missing document: ${document}`);
  });

  it('상대 Markdown 링크가 모두 실제 파일을 가리킨다', () => {
    assert.deepEqual(brokenLinks(PACKAGE_ROOT, markdownFiles(PACKAGE_ROOT)), []);
  });

  it('링크 검사가 끊어진 링크를 실제로 찾아낸다', (t) => {
    const space = tempSpace(t);
    mkdirSync(space.path('docs'));
    writeFileSync(space.path('docs', 'ok.md'), '# 있음\n');
    writeFileSync(
      space.path('docs', 'a.md'),
      ['[있음](ok.md)', '[앵커](ok.md#있음)', '[외부](https://example.invalid/none)', '[자기 앵커](#x)', '`[코드](none-inline.md)`', '```', '[펜스](none-fenced.md)', '```', '[끊김](none.md)', '[참조]: ../none-ref.md'].join('\n'),
    );
    assert.deepEqual(brokenLinks(space.root, ['docs/a.md']), ['docs/a.md -> none.md', 'docs/a.md -> ../none-ref.md']);
  });

  it('구현의 모든 CLI 명령이 docs/retrieval.md에 있다', () => {
    const text = retrieval();
    assert.ok(COMMANDS.length > 0);
    for (const command of COMMANDS) assert.match(text, new RegExp(`agent-knowledge ${command}\\b`), `missing command: ${command}`);
  });

  it('모든 ErrorCode와 종료 코드가 docs/retrieval.md 표와 일치한다', () => {
    const table = exitTable(retrieval());
    for (const [code, exit] of Object.entries(EXIT_CODES)) assert.equal(table.get(code), exit, `exit code row for ${code}`);
    assert.equal(table.get('ok'), 0);
    // 결과 없음은 ErrorCode가 아니지만 호출자가 구분해야 하는 종료 코드다
    assert.equal(table.get('no-results'), 3);
  });
});
