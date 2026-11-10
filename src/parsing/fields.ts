import { isPhase, normalizeStatus, type BaseStatus, type BasisRef, type HttpOperation, type InformalSyntax, type Phase, type Relation, type Relations } from '../model.js';
import { compareStrings, sortedUnique } from '../util/compare.js';
import { normalizeRepoPath } from '../util/paths.js';

// 표시 뒤 공백을 전부 먹은 뒤에만 이름이 시작해야 공백이 긴 줄에서 이차 시간이 되지 않는다
const FIELD_LINE = /^\s*[-*+]\s+(?=\S)([^:：`|\n]{1,16}?)\s*[:：]\s*(.*)$/;
const EMPHASIS_MARK = /^(?:\*{1,3}|_{1,3})/;
const INFORMAL_STATUS = /^\s*(?:\*{1,3}|_{1,3})?(?:상태|status)(?:\*{1,3}|_{1,3})?\s*[:：]\s*(.*)$/i;
const TABLE_STATUS_NAME = /^(?:\*{1,3}|_{1,3})?(?:상태|status)(?:\*{1,3}|_{1,3})?$/i;
const ORDERED_ITEM = /^\s*\d{1,9}[.)][ \t]+(.*)$/;
const QUOTE_MARKERS = /^(?: {0,3}>[ \t]?)+/;
const HTTP_METHOD = 'GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT';
const HTTP_OPERATION_TOKEN = new RegExp(`^(?:${HTTP_METHOD})(?:[ \\t]+|:)/[^\\s\`]*$`, 'i');
const HTTP_OPERATION_IN_VALUE = new RegExp(`(?<![\\p{L}\\p{N}_])(${HTTP_METHOD})(?:[ \\t]+|:)(/[^\\s\`,·]*)`, 'giu');
const OPERATION_TRAILER = /[.,;:)\]'"]+$/;
const VALUE_TOKEN = /`([^`]+)`|([^\s,·`]+)/g;
const BACKTICKED = /`([^`]+)`/g;
const REFERENCE = /(?:[a-z0-9][a-z0-9._-]{0,63}:)?\b(?:BR|FEAT|FLOW|POL|CON|DEP)-[A-Za-z0-9_-]*[A-Za-z0-9]/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const LINE_SUFFIX = /:\d+(?:[-:]\d+)?$/;
const GLOBAL_TOKENS = new Set(['전체', '전역', '*', 'global']);

type ScalarField = 'status' | 'basis' | 'mandatory' | 'scope' | 'phase' | 'conditions' | 'aliases' | 'kind';

const SCALAR_FIELDS = new Map<string, ScalarField>([
  ['상태', 'status'], ['status', 'status'],
  ['근거', 'basis'], ['출처', 'basis'], ['basis', 'basis'],
  ['구분', 'mandatory'], ['mandatory', 'mandatory'],
  ['범위', 'scope'], ['scope', 'scope'],
  ['단계', 'phase'], ['phase', 'phase'],
  ['조건', 'conditions'], ['적용조건', 'conditions'],
  ['별칭', 'aliases'], ['aliases', 'aliases'],
  ['종류', 'kind'], ['kind', 'kind'],
]);

const RELATION_FIELDS = new Map<string, Relation>([
  ['정책', 'policy'], ['기능', 'feature'], ['흐름', 'flow'], ['계약', 'contract'], ['의존', 'dependency'],
  ['코드', 'code'], ['테스트', 'test'], ['충돌', 'conflicts_with'], ['대체', 'supersedes'], ['연결', 'related'],
]);

/** 값이 자유문이어도 선언 자체를 잃으면 안 되는 관계. */
const RAW_FALLBACK_RELATIONS = new Set<Relation>(['conflicts_with', 'dependency']);
const NONE_MARKERS = ['해당사항없음', '해당없습니다', '해당없음', '없습니다', '없음', '없다', 'none', 'n/a', 'na', 'nil', 'null', '-', '—'];
const BLANK = /\s/;
const NONE_PUNCTUATION = /\p{P}/u;
/** 식별자 안에서도 쓰는 문장부호. 뒤에 글자가 이어지면 `na-service`처럼 값의 일부다. */
const IDENTIFIER_JOINER = /[-_./:]/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const TABLE_DELIMITER_CELL = /^\s*:?-+:?\s*$/;
/** 비공식 표기가 여럿이면 가장 낮은 상태를 쓴다. 확정 계열은 올릴 수 없으므로 없다. */
const DEMOTING_STATUSES: readonly BaseStatus[] = ['deprecated', 'unverified', 'observed_behavior'];

export interface InformalStatus {
  raw: string;
  status: BaseStatus;
  syntax: InformalSyntax;
}

export interface ParsedFields {
  statusRaw: string | null;
  /** 정식 필드가 아닌 표기 중 상태를 낮추는 값의 원문. 정식 상태가 없을 때만 쓴다. */
  informalStatusRaw: string | null;
  /** 상태 어휘로 읽히는 비공식 표기의 원문 전부. 진단에 쓴다. */
  informalStatusValues: string[];
  /** 상태 어휘로 읽히는 비공식 표기와 그 문법. informalApplied는 informalStatusRaw로 고른 표기의 위치다. */
  informalStatuses: InformalStatus[];
  informalApplied: number | null;
  basisRefs: BasisRef[];
  mandatory: boolean;
  global: boolean;
  paths: string[];
  phases: Phase[];
  conditions: string | null;
  aliases: string[];
  relations: Relations;
  kind: string | null;
  operations: HttpOperation[];
}

/** `PATCH /auth/x`, `GET:/auth/x` 같은 토큰은 슬래시가 있어도 파일 경로가 아니다. */
export function isHttpOperation(token: string): boolean {
  return HTTP_OPERATION_TOKEN.test(token);
}

/** Windows 작성자의 `src\auth\`도 `src/auth/`와 같이 읽는다. 구분자 변환은 normalizeRepoPath가 한다. */
function isPathLike(token: string): boolean {
  return !URL_SCHEME.test(token) && !isHttpOperation(token) && (token.includes('/') || token.includes('\\') || FILE_EXTENSION.test(token));
}

export function compareOperations(a: HttpOperation, b: HttpOperation): number {
  return compareStrings(a.field, b.field) || compareStrings(a.method, b.method) || compareStrings(a.path, b.path);
}

/** 값 안의 HTTP 작업을 모두 뽑는다. 백틱 안팎을 가리지 않는다. */
export function operationsOf(value: string, field: HttpOperation['field']): HttpOperation[] {
  const found = new Map<string, HttpOperation>();
  for (const match of value.normalize('NFC').matchAll(HTTP_OPERATION_IN_VALUE)) {
    const path = match[2]!.replace(OPERATION_TRAILER, '');
    if (path === '') continue;
    const operation: HttpOperation = { method: match[1]!.toUpperCase() as HttpOperation['method'], path, field };
    found.set(`${operation.method} ${operation.path}`, operation);
  }
  return [...found.values()];
}

export function mergeOperations(...lists: readonly HttpOperation[][]): HttpOperation[] {
  const merged = new Map<string, HttpOperation>();
  for (const operation of lists.flat()) merged.set(`${operation.field}\0${operation.method}\0${operation.path}`, operation);
  return [...merged.values()].sort(compareOperations);
}

function valueTokens(value: string): string[] {
  return [...value.matchAll(VALUE_TOKEN)].map((match) => match[1] ?? match[2]!);
}

export function normalizeCodePath(token: string): string | null {
  const stripped = token.replaceAll('`', '').replace(/#.*$/, '').replace(LINE_SUFFIX, '');
  return isPathLike(stripped) ? normalizeRepoPath(stripped) : null;
}

function stripEmphasisMarks(text: string): string {
  return text.replace(/^(?:\*{1,3}|_{1,3})|(?:\*{1,3}|_{1,3})$/g, '').trim();
}

/** `**상태**:`, `**상태:**`, `**상태: 값**` 어느 쪽이든 이름과 값에서 강조를 벗긴다. */
function withoutEmphasis(name: string, value: string): { name: string; value: string } {
  const mark = EMPHASIS_MARK.exec(name)?.[0];
  if (!mark) return { name, value };
  if (name.length > mark.length * 2 && name.endsWith(mark)) return { name: name.slice(mark.length, -mark.length), value };
  if (value.startsWith(mark)) return { name: name.slice(mark.length), value: value.slice(mark.length).trim() };
  if (value.endsWith(mark)) return { name: name.slice(mark.length), value: value.slice(0, -mark.length).trim() };
  return { name, value };
}

function plainOrTableStatus(line: string): { raw: string; syntax: 'plain' | 'table' } | null {
  const plain = INFORMAL_STATUS.exec(line);
  if (plain) return { raw: stripEmphasisMarks(plain[1]!.trim()), syntax: 'plain' };
  const row = line.trim();
  if (!row.startsWith('|')) return null;
  const cells = row.slice(1, row.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());
  return cells.length === 2 && TABLE_STATUS_NAME.test(cells[0]!) ? { raw: stripEmphasisMarks(cells[1]!), syntax: 'table' } : null;
}

/** 정식 필드가 아닌 상태 표기를 찾는다. 인용문 안은 다른 문서를 옮긴 것일 수 있어 문법을 따로 표시한다. */
function informalStatusValue(line: string): { raw: string; syntax: InformalSyntax } | null {
  const quote = QUOTE_MARKERS.exec(line);
  if (quote) {
    const inner = line.slice(quote[0].length);
    const field = FIELD_LINE.exec(inner);
    if (field) {
      const { name, value } = withoutEmphasis(field[1]!.trim(), field[2]!.trim());
      return SCALAR_FIELDS.get(name.replace(/\s/g, '').toLowerCase()) === 'status' ? { raw: value, syntax: 'quote' } : null;
    }
    const nested = informalStatusValue(inner);
    return nested === null ? null : { raw: nested.raw, syntax: 'quote' };
  }
  const ordered = ORDERED_ITEM.exec(line);
  if (ordered) {
    const inner = INFORMAL_STATUS.exec(ordered[1]!);
    return inner ? { raw: stripEmphasisMarks(inner[1]!.trim()), syntax: 'ordered-list' } : null;
  }
  return plainOrTableStatus(line);
}

function isTableDelimiter(line: string | undefined): boolean {
  if (line === undefined || !line.includes('|')) return false;
  const row = line.trim();
  return row.slice(row.startsWith('|') ? 1 : 0, row.endsWith('|') ? -1 : undefined).split('|').every((cell) => TABLE_DELIMITER_CELL.test(cell));
}

/** 공백을 건너뛰며 맞춰 본다. 표시 다음 위치를 돌려주고, 맞지 않으면 -1이다. */
function endOfMarker(value: string, marker: string): number {
  let position = 0;
  for (const character of marker) {
    while (position < value.length && BLANK.test(value[position]!)) position++;
    if (value[position] !== character) return -1;
    position++;
  }
  return position;
}

/** `해당 없음.`, `없음 (검토 완료)`처럼 없다는 뜻의 값인지 본다. `NA 리전 정책`처럼 표시 뒤에 낱말이 이어지면 선언된 값이다. */
function isNoneMarker(rawValue: string): boolean {
  const value = rawValue.normalize('NFC').toLowerCase();
  return NONE_MARKERS.some((marker) => {
    const end = endOfMarker(value, marker);
    if (end < 0) return false;
    let next = end;
    while (next < value.length && BLANK.test(value[next]!)) next++;
    if (next === value.length) return true;
    const character = value[next]!;
    return NONE_PUNCTUATION.test(character) && !(IDENTIFIER_JOINER.test(character) && WORD_CHARACTER.test(value[next + 1] ?? ''));
  });
}

function relationTargets(relation: Relation, value: string): string[] {
  if (relation === 'code' || relation === 'test') return valueTokens(value).flatMap((token) => normalizeCodePath(token) ?? []);
  const quoted = [...value.matchAll(BACKTICKED)].map((match) => match[1]!);
  const rest = value.replace(BACKTICKED, ' ');
  return [...quoted, ...[...rest.matchAll(REFERENCE)].map((match) => match[0])];
}

function pathRef(token: string): BasisRef | null {
  const hash = token.indexOf('#');
  const path = normalizeRepoPath((hash < 0 ? token : token.slice(0, hash)).replace(LINE_SUFFIX, ''));
  if (path === null) return null;
  return hash < 0 ? { kind: 'path', value: path } : { kind: 'path', value: path, anchor: token.slice(hash + 1) };
}

function basisRef(token: string): BasisRef {
  const typed = /^(path|commit|item|verify):(.+)$/.exec(token);
  if (typed) {
    const kind = typed[1] as BasisRef['kind'];
    return (kind === 'path' ? pathRef(typed[2]!) : { kind, value: typed[2]! }) ?? { kind: 'opaque', value: token };
  }
  const bare = token.replace(/#.*$/, '').replace(LINE_SUFFIX, '');
  return (isPathLike(bare) ? pathRef(token) : null) ?? { kind: 'opaque', value: token };
}

function isBasisToken(token: string): boolean {
  return /^(?:path|commit|item|verify):./.test(token) || isPathLike(token.replace(/#.*$/, '').replace(LINE_SUFFIX, ''));
}

/** 문장 속 경로가 근거로 해석되지 않도록, 모든 토큰이 참조일 때만 토큰별로 읽고 아니면 값 전체를 opaque로 둔다. */
export function parseBasisRefs(values: readonly string[]): BasisRef[] {
  const refs = new Map<string, BasisRef>();
  for (const value of values) {
    const cleaned = value.replaceAll('`', '').trim();
    const tokens = valueTokens(value);
    if (tokens.length === 0) continue;
    if (tokens.every(isBasisToken)) for (const token of tokens) refs.set(token, basisRef(token));
    else refs.set(cleaned, { kind: 'opaque', value: cleaned });
  }
  return [...refs.values()];
}

export function mergeRelations(...sources: Relations[]): Relations {
  const merged: Relations = {};
  for (const source of sources) {
    for (const [relation, targets] of Object.entries(source) as [Relation, string[]][]) {
      merged[relation] = sortedUnique([...(merged[relation] ?? []), ...targets]);
    }
  }
  return merged;
}

export function parseFields(lines: readonly string[]): ParsedFields {
  const scalars = new Map<ScalarField, string>();
  const relationValues = new Map<Relation, string>();
  const basisValues: string[] = [];
  const informal: InformalStatus[] = [];
  const operations: HttpOperation[][] = [];
  for (const [index, line] of lines.entries()) {
    const match = FIELD_LINE.exec(line);
    if (!match) {
      // 구분 행 바로 위의 행은 이름·값 행이 아니라 표 머리글이다
      const found = isTableDelimiter(lines[index + 1]) ? null : informalStatusValue(line);
      const status = found === null ? null : normalizeStatus(found.raw);
      if (status !== null) informal.push({ raw: found!.raw, status, syntax: found!.syntax });
      continue;
    }
    const field = withoutEmphasis(match[1]!.trim(), match[2]!.trim());
    const name = field.name.replace(/\s/g, '').replace(/^관련/, '').toLowerCase();
    const { value } = field;
    const scalar = SCALAR_FIELDS.get(name);
    const relation = RELATION_FIELDS.get(name);
    if (scalar === 'scope' || relation === 'code' || relation === 'test') operations.push(operationsOf(value, scalar === 'scope' ? 'scope' : (relation as 'code' | 'test')));
    if (scalar === 'basis') basisValues.push(value);
    else if (scalar) scalars.set(scalar, scalars.has(scalar) ? `${scalars.get(scalar)} ${value}` : value);
    else if (relation) relationValues.set(relation, relationValues.has(relation) ? `${relationValues.get(relation)} ${value}` : value);
  }

  const paths: string[] = [];
  const conditionParts: string[] = [];
  let global = false;
  for (const token of valueTokens(scalars.get('scope') ?? '')) {
    const path = isPathLike(token) ? normalizeRepoPath(token) : null;
    if (GLOBAL_TOKENS.has(token.toLowerCase())) global = true;
    else if (path !== null) paths.push(path);
    else conditionParts.push(token);
  }
  if (scalars.get('conditions')) conditionParts.push(scalars.get('conditions')!);

  const phaseTokens = valueTokens(scalars.get('phase') ?? '');
  const relations: Relations = {};
  for (const [relation, value] of relationValues) {
    const targets = relationTargets(relation, value);
    if (targets.length > 0) relations[relation] = sortedUnique(targets);
    else if (RAW_FALLBACK_RELATIONS.has(relation) && value !== '' && !isNoneMarker(value)) relations[relation] = [value];
  }
  const flowTokens = phaseTokens.filter((token) => !isPhase(token));
  if (flowTokens.length > 0) relations.flow = sortedUnique([...(relations.flow ?? []), ...flowTokens]);

  const mandatory = scalars.get('mandatory');
  // 번호 목록과 인용문 안의 표기는 기록하고 진단만 한다. 번호 목록은 절차의 한 단계, 인용문은 옮겨 적은 글일 수 있어 상태를 낮추는 데도 쓰지 않는다
  const applicable = informal.filter((entry) => entry.syntax === 'plain' || entry.syntax === 'table');
  const demoting = DEMOTING_STATUSES.flatMap((status) => applicable.filter((entry) => entry.status === status))[0];
  return {
    statusRaw: scalars.get('status') ?? null,
    informalStatusRaw: demoting?.raw ?? null,
    informalStatusValues: informal.map((entry) => entry.raw),
    informalStatuses: informal,
    informalApplied: demoting === undefined ? null : informal.indexOf(demoting),
    basisRefs: parseBasisRefs(basisValues),
    mandatory: mandatory === '필수' || mandatory === 'mandatory',
    global,
    paths: sortedUnique(paths),
    phases: sortedUnique(phaseTokens.filter(isPhase)) as Phase[],
    conditions: conditionParts.length > 0 ? conditionParts.join(' ') : null,
    aliases: sortedUnique((scalars.get('aliases') ?? '').replaceAll('`', '').split(/[,·]/).map((alias) => alias.trim()).filter(Boolean)),
    relations,
    kind: scalars.get('kind') ?? null,
    operations: mergeOperations(...operations),
  };
}
