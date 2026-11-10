import type { Unit } from '../model.js';
import { frontmatterVerdict } from './frontmatter.js';

interface MarkdownSection {
  unit: Unit;
  anchor: string;
  key: string | null;
  /** `document` 단위는 비어 있고 문서 제목은 build-items에서 정한다. */
  title: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  content: string;
  /** 제목 줄을 뺀 본문 중 펜스·HTML 주석·원시 HTML·들여쓰기 코드 밖의 줄. 필드는 여기서만 읽는다. */
  fieldLines: string[];
  /** 가까운 조상부터의 `sections` 위치. 내보내지 않은 조상 절은 본문이 없어 필드도 없으므로 뺀다. */
  ancestors: number[];
}

interface ScannedMarkdown {
  lineCount: number;
  frontmatter: string | null;
  /** 맨 앞 `---` 영역이 YAML로 읽히지 않아 본문으로 돌렸을 때의 오류. */
  frontmatterError: string | null;
  firstH1: string | null;
  sections: MarkdownSection[];
  /** BOM과 줄바꿈을 정리한 문서 전체. */
  text: string;
  /** 줄마다 펜스·HTML 주석·원시 HTML·들여쓰기 코드·frontmatter 안인지. 긴 항목을 나눌 때 이 줄들 사이를 자르지 않는다. */
  opaque: boolean[];
}

interface Heading {
  index: number;
  bodyIndex: number;
  level: number;
  text: string;
  key: string | null;
  entryTitle: string | null;
  /** setext 제목의 밑줄 문자. ATX 제목은 null이다. */
  underline: '=' | '-' | null;
}

type BlockKind = { kind: 'fence'; char: string; length: number } | { kind: 'comment' } | { kind: 'raw-html' };
/** 닫힐 때까지 제목과 필드 탐지에서 빼는 블록. 자기를 담은 목록이나 인용이 끝나면 함께 끝난다. */
type OpaqueBlock = BlockKind & { quoteDepth: number; offset: number };

// 들여쓰기는 컨테이너 내용 오프셋 기준으로 따로 재므로 아래 네 표시는 줄의 내용부터 맞춘다
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
const COMMENT_OPEN = /^<!--/;
const RAW_HTML_OPEN = /^<(?:pre|script|style|textarea)(?:[\s>]|$)/i;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RAW_HTML_CLOSE = /<\/(?:pre|script|style|textarea)>/i;
const ENTRY_HEADING = /^`([^`]+)`\s*(.*)$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-{2,})[ \t]*$/;
const LIST_OR_QUOTE = /^\s*(?:[-*+](?:\s|$)|\d+[.)](?:\s|$)|>)/;
const INDENTED_OR_RULE = /^(?: {4}|\t)|^ {0,3}([-*_=])(?:[ \t]*\1)*[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_MARKER = /(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/y;
const MAX_MARKER_PADDING = 4;
const CODE_INDENT = 4;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** 공백이 긴 줄에서 정규식이 이차 시간이 되지 않도록 끝에서부터 자른다. */
function trimEndBlanks(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(0, end);
}

function atxTitle(raw: string): string {
  const text = trimEndBlanks(raw);
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === text.length) return text;
  if (end === 0) return '';
  return text[end - 1] === ' ' || text[end - 1] === '\t' ? trimEndBlanks(text.slice(0, end)) : text;
}

function isParagraphLine(line: string): boolean {
  return !isBlank(line) && !LIST_OR_QUOTE.test(line) && !INDENTED_OR_RULE.test(line) && !line.includes('|');
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replaceAll(' ', '-') || 'section';
}

function entrySlug(key: string): string {
  return key.replaceAll('%', '%25').replaceAll('#', '%23').replace(/\s/g, '-');
}

/** `from`부터 공백을 건너뛴 위치와 열을 돌려준다. 탭은 4칸 탭 정지로 센다. */
function skipBlanks(text: string, from: number, column: number): { start: number; column: number } {
  let start = from;
  let current = column;
  for (; start < text.length; start++) {
    if (text[start] === ' ') current++;
    else if (text[start] === '\t') current += 4 - (current % 4);
    else break;
  }
  return { start, column: current };
}

/** 줄 앞의 인용 접두사를 `limit`개까지 벗긴다. */
function stripQuotes(line: string, limit: number): { depth: number; rest: string } {
  let depth = 0;
  let position = 0;
  while (depth < limit) {
    let marker = position;
    while (marker - position < 3 && line[marker] === ' ') marker++;
    if (line[marker] !== '>') break;
    position = marker + 1;
    if (line[position] === ' ') position++;
    depth++;
  }
  return { depth, rest: depth === 0 ? line : line.slice(position) };
}

/** 줄 앞의 목록 표시를 모두 읽어 내용 오프셋을 쌓고 내용의 위치를 돌려준다. */
function consumeListMarkers(rest: string, indent: { start: number; column: number }, containers: number[]): { start: number; column: number; marked: boolean } {
  let { start, column } = indent;
  let marked = false;
  while (column - (containers.at(-1) ?? 0) < CODE_INDENT) {
    LIST_MARKER.lastIndex = start;
    const marker = LIST_MARKER.exec(rest)?.[0];
    if (marker === undefined) break;
    const markerEnd = column + marker.length;
    const after = skipBlanks(rest, start + marker.length, markerEnd);
    const padding = after.column - markerEnd;
    containers.push(markerEnd + (after.start === rest.length || padding > MAX_MARKER_PADDING ? 1 : padding));
    ({ start, column } = after);
    marked = true;
  }
  return { start, column, marked };
}

/** 여는 표시이면 블록 종류를, 같은 줄에서 닫히면 'closed'를, 아니면 null을 돌려준다. */
function openerOf(content: string): BlockKind | 'closed' | null {
  const fence = FENCE_OPEN.exec(content);
  // 백틱 펜스의 정보 문자열에 백틱이 있으면 인라인 코드다
  if (fence && !(fence[1]![0] === '`' && fence[2]!.includes('`'))) return { kind: 'fence', char: fence[1]![0]!, length: fence[1]!.length };
  if (COMMENT_OPEN.test(content)) return content.includes('-->', 4) ? 'closed' : { kind: 'comment' };
  if (RAW_HTML_OPEN.test(content)) return RAW_HTML_CLOSE.test(content) ? 'closed' : { kind: 'raw-html' };
  return null;
}

function closesBlock(block: OpaqueBlock, line: string, content: string, relative: number): boolean {
  if (block.kind === 'comment') return line.includes('-->');
  if (block.kind === 'raw-html') return RAW_HTML_CLOSE.test(line);
  const closing = relative < CODE_INDENT ? FENCE_CLOSE.exec(content)?.[1] : undefined;
  return closing !== undefined && closing[0] === block.char && closing.length >= block.length;
}

function makeHeading(line: string, index: number, bodyIndex: number, level: number, text: string, underline: Heading['underline']): Heading {
  // code-agent의 항목 표기와 같게 들여쓰기 없는 `###`만 항목으로 본다
  const entry = level === 3 && line.startsWith('###') ? ENTRY_HEADING.exec(text) : null;
  const key = entry?.[1]!.trim() || null;
  return { index, bodyIndex, level, text, key, entryTitle: key === null ? null : entry![2]! || key, underline };
}

export function scanMarkdown(rawText: string): ScannedMarkdown {
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const lines = text.split(/\r\n|\n|\r/);
  const lineCount = lines.at(-1) === '' ? lines.length - 1 : lines.length;

  let bodyStart = 0;
  let frontmatter: string | null = null;
  let frontmatterError: string | null = null;
  let rejectedClose = -1;
  if (lines[0] === '---') {
    const close = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'));
    if (close > 0) {
      const region = lines.slice(1, close).join('\n');
      const verdict = frontmatterVerdict(region);
      if (verdict.isFrontmatter) {
        frontmatter = region;
        bodyStart = close + 1;
      } else {
        // 여는 `---`는 구분선일 뿐이므로 내용 없는 도입부 항목이 생기지 않게 건너뛴다
        bodyStart = 1;
        rejectedClose = close;
        frontmatterError = verdict.error;
      }
    }
  }

  const opaque = new Array<boolean>(lines.length).fill(false);
  const comment = new Array<boolean>(lines.length).fill(false);
  const candidates: Heading[] = [];
  let block: OpaqueBlock | null = null;
  /** 열린 목록 항목의 내용 오프셋. 바깥부터 쌓이며, 인용 안이면 접두사 뒤의 열 기준이다. */
  let containers: number[] = [];
  let quoteDepth = 0;
  let paragraphStart: number | null = null;
  /** 지금 문단이 목록이나 인용의 문단이다. 이어지는 줄은 컨테이너 밖에 있어도 제목이 되지 못한다. */
  let continuing = false;
  let atBlockBoundary = true;
  const endParagraph = (): void => {
    paragraphStart = null;
    continuing = false;
  };

  for (let index = bodyStart; index < lines.length; index++) {
    const line = lines[index]!;
    if (block) {
      const quoted = stripQuotes(line, block.quoteDepth);
      const at = skipBlanks(quoted.rest, 0, 0);
      if (quoted.depth === block.quoteDepth && (isBlank(quoted.rest) || at.column >= block.offset)) {
        opaque[index] = true;
        comment[index] = block.kind === 'comment';
        if (closesBlock(block, line, quoted.rest.slice(at.start), at.column - block.offset)) block = null;
        continue;
      }
      block = null;
    }

    // 목록 안에서 들여쓴 `>`는 그 항목의 내용이다. 접두사로 벗기면 목록 컨테이너를 잃는다
    const ownedByList = quoteDepth === 0 && containers.length > 0 && skipBlanks(line, 0, 0).column >= containers[0]!;
    const { depth, rest } = stripQuotes(line, ownedByList ? 0 : Infinity);
    if (depth !== quoteDepth) {
      containers = [];
      quoteDepth = depth;
    }
    if (isBlank(rest)) {
      endParagraph();
      atBlockBoundary = true;
      continue;
    }

    const indent = skipBlanks(rest, 0, 0);
    while (containers.length > 0 && indent.column < containers.at(-1)!) containers.pop();
    const { start, column, marked } = THEMATIC_BREAK.test(rest) ? { ...indent, marked: false } : consumeListMarkers(rest, indent, containers);
    const base = containers.at(-1) ?? 0;
    const relative = column - base;
    const content = rest.slice(start);

    const opener = relative < CODE_INDENT ? openerOf(content) : null;
    if (opener) {
      opaque[index] = true;
      comment[index] = COMMENT_OPEN.test(content);
      block = opener === 'closed' ? null : { ...opener, quoteDepth, offset: base };
      endParagraph();
      atBlockBoundary = true;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      candidates.push(makeHeading(line, index, index + 1, atx[1]!.length, atxTitle(atx[2] ?? ''), null));
      containers = [];
      endParagraph();
      atBlockBoundary = true;
      continue;
    }
    if (relative >= CODE_INDENT && atBlockBoundary && !marked) {
      opaque[index] = true;
      endParagraph();
      continue;
    }
    atBlockBoundary = false;
    if (marked || depth > 0 || containers.length > 0) {
      paragraphStart = null;
      continuing = content !== '' && !ATX.test(content) && !THEMATIC_BREAK.test(content);
      continue;
    }
    if (!isParagraphLine(line)) {
      endParagraph();
      continue;
    }
    if (continuing) continue;
    paragraphStart ??= index;
    // 본문으로 돌린 영역의 닫는 `---`는 구분선이다. 밑줄로 보면 그 영역의 글이 빈 제목 절로 사라진다
    const underline = index + 1 < lines.length && index + 1 !== rejectedClose ? SETEXT_UNDERLINE.exec(lines[index + 1]!) : null;
    if (underline) {
      const headingText = lines.slice(paragraphStart, index + 1).map((part) => part.trim()).join(' ');
      const char = underline[1]![0] as '=' | '-';
      candidates.push(makeHeading(line, paragraphStart, index + 2, char === '=' ? 1 : 2, headingText, char));
      index += 1;
      endParagraph();
      atBlockBoundary = true;
    }
  }

  const hasText = (from: number, stop: number): boolean => lines.slice(from, stop).some((line) => !isBlank(line));
  const hasBodyText = (from: number, stop: number): boolean => {
    for (let i = from; i < stop; i++) if (!isBlank(lines[i]!) && !THEMATIC_BREAK.test(lines[i]!)) return true;
    return false;
  };
  // 본문 없는 `-` 밑줄은 구분선이고 그 문단은 앞 절의 본문이다. 뒤쪽 밑줄이 구분선이 되면 그 글이 앞 제목의 본문이 되므로 뒤에서부터 본다
  const headings: Heading[] = [];
  for (let h = candidates.length - 1; h >= 0; h--) {
    const heading = candidates[h]!;
    if (heading.underline !== '-' || hasBodyText(heading.bodyIndex, headings.at(-1)?.index ?? lines.length)) headings.push(heading);
  }
  headings.reverse();

  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const claim = (candidate: string): string => {
    let anchor = candidate;
    if (used.has(anchor)) {
      // 같은 제목이 많아도 이미 쓴 접미사를 처음부터 다시 훑지 않는다
      let n = nextSuffix.get(candidate) ?? 1;
      do anchor = `${candidate}-${n++}`;
      while (used.has(anchor));
      nextSuffix.set(candidate, n);
    }
    used.add(anchor);
    return anchor;
  };
  const anchorOf = (heading: Heading): string => claim(heading.key === null ? slugify(heading.text) : entrySlug(heading.key));

  const sections: MarkdownSection[] = [];
  const emit = (fields: Omit<MarkdownSection, 'endLine' | 'content' | 'fieldLines'>, bodyIndex: number, stop: number): void => {
    let last = stop - 1;
    while (isBlank(lines[last]!)) last--;
    const fieldLines: string[] = [];
    for (let i = bodyIndex; i < stop; i++) if (!opaque[i]) fieldLines.push(lines[i]!);
    sections.push({ ...fields, endLine: last + 1, content: lines.slice(fields.startLine - 1, last + 1).join('\n'), fieldLines });
  };

  const introStop = headings[0]?.index ?? lines.length;
  // 주석이나 구분선뿐인 도입부를 항목으로 만들면 frontmatter의 id와 별칭을 그 빈 항목이 가져간다
  let introHasContent = false;
  for (let i = bodyStart; i < introStop && !introHasContent; i++) introHasContent = !isBlank(lines[i]!) && !comment[i] && !THEMATIC_BREAK.test(lines[i]!);
  if (introHasContent) {
    let first = bodyStart;
    while (isBlank(lines[first]!)) first++;
    emit({ unit: 'document', anchor: claim('_intro'), key: null, title: '', headingPath: [], startLine: first + 1, ancestors: [] }, first, introStop);
  }

  const stack: { level: number; text: string; section: number | null }[] = [];
  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h]!;
    const anchor = anchorOf(heading);
    while (stack.length > 0 && stack.at(-1)!.level >= heading.level) stack.pop();
    const ancestors = stack.flatMap((entry) => entry.section ?? []).reverse();
    const frame: (typeof stack)[number] = { level: heading.level, text: heading.text.replaceAll('`', ''), section: null };
    stack.push(frame);

    let next = h + 1;
    if (heading.key !== null) {
      // 항목 안의 일반 소제목은 항목에 남지만 앵커는 줄 순서대로 차지한다
      while (next < headings.length && headings[next]!.level > 2 && headings[next]!.key === null) {
        anchorOf(headings[next]!);
        next++;
      }
    }
    const stop = headings[next]?.index ?? lines.length;
    // `=` 밑줄 제목은 문단을 제목으로 삼았으므로 본문이 없어도 내보내야 글을 잃지 않는다
    if (heading.key !== null || heading.underline === '=' || hasText(heading.bodyIndex, stop)) {
      frame.section = sections.length;
      emit(
        {
          unit: heading.key === null ? 'section' : 'entry',
          anchor,
          key: heading.key,
          title: heading.entryTitle ?? heading.text,
          headingPath: stack.map((entry) => entry.text),
          startLine: heading.index + 1,
          ancestors,
        },
        heading.bodyIndex,
        stop,
      );
    }
    h = next - 1;
  }

  const firstH1 = headings.find((heading) => heading.level === 1)?.text || null;
  for (let i = 0; i < bodyStart; i++) opaque[i] = true;
  return { lineCount, frontmatter, frontmatterError, firstH1, sections, text: lines.slice(0, lineCount).join('\n'), opaque: opaque.slice(0, lineCount) };
}

/** 절이 하나도 나오지 않은 문서를 대신하는 문서 전체 항목. */
export function wholeDocumentSection(scanned: ScannedMarkdown): MarkdownSection {
  return { unit: 'document', anchor: '_intro', key: null, title: '', headingPath: [], startLine: 1, endLine: scanned.lineCount, content: scanned.text, fieldLines: [], ancestors: [] };
}
