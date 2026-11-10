import type { DatabaseSync } from 'node:sqlite';
import type { Bm25Config } from '../profiles/config.js';
import { tokenCountOf, wordsOf } from '../parsing/tokenize.js';
import { buildMatch, foldKey, type QueryTerm } from './query.js';
import { all, ITEM_SOURCE, placeholders, selectItems, type ScopedItem, type SqlPredicate } from './scope.js';

export const SEARCH_FIELDS = ['key_aliases', 'title', 'headings', 'body'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

export interface SegmentRow {
  pk: number;
  itemPk: number;
  ordinal: number;
  segmentId: string;
  startLine: number;
  endLine: number;
  content: string;
  sha256: string;
  tokenCount: number;
}

/** 순위를 매기는 단위. 나뉜 항목은 조각마다, 나뉘지 않은 항목은 항목 전체가 하나다. */
export interface SearchUnit {
  item: ScopedItem;
  segment: SegmentRow | null;
  fields: Record<SearchField, string>;
  tokenCount: number;
}

const SEGMENT_COLUMNS = 's.segment_pk AS pk, s.item_pk AS itemPk, s.ordinal AS ordinal, s.segment_id AS segmentId, s.start_line AS startLine, s.end_line AS endLine, s.content AS content, s.content_sha256 AS sha256, s.token_count AS tokenCount';
const UNSPLIT = 'NOT EXISTS (SELECT 1 FROM item_segments s WHERE s.item_pk = i.item_pk)';

export function fieldsOf(item: ScopedItem, body: string = item.content): Record<SearchField, string> {
  return { key_aliases: [item.key ?? '', ...item.aliases].join(' '), title: item.title, headings: item.headingPath.join(' '), body };
}

/** 스키마 2 이전에 색인한 항목은 길이를 저장하지 않았으므로 같은 규칙으로 다시 센다. */
export function itemTokenCount(item: ScopedItem): number {
  return item.tokenCount ?? tokenCountOf(item);
}

function unitOfItem(item: ScopedItem): SearchUnit {
  return { item, segment: null, fields: fieldsOf(item), tokenCount: itemTokenCount(item) };
}

/** 질의와 FTS로 일치하는 단위를 모은다. segments가 거짓이면 항목만 쓴다. */
export function matchingUnits(db: DatabaseSync, predicate: SqlPredicate, terms: readonly QueryTerm[], segments: boolean): SearchUnit[] {
  const match = buildMatch(terms);
  if (!segments) return selectItems(db, predicate, { sql: 'i.item_pk IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)', params: [match] }).map(unitOfItem);

  const units = selectItems(db, predicate, { sql: `i.item_pk IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?) AND ${UNSPLIT}`, params: [match] }).map(unitOfItem);
  // 범위·세대 조건을 SQL 안에 둔다. 범위 밖이나 다른 세대의 조각 수가 이 요청의 메모리·바인딩 변수 수를 정하지 않게 한다
  const segmentMatch = 's.segment_pk IN (SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?)';
  const rows = all<SegmentRow>(db, `SELECT ${SEGMENT_COLUMNS} FROM item_segments s WHERE s.item_pk IN (SELECT i.item_pk FROM ${ITEM_SOURCE} WHERE ${predicate.sql}) AND ${segmentMatch}`, [...predicate.params, match]);
  if (rows.length === 0) return units;
  const items = new Map(selectItems(db, predicate, { sql: `i.item_pk IN (SELECT s.item_pk FROM item_segments s WHERE ${segmentMatch})`, params: [match] }).map((item) => [item.pk, item]));
  for (const row of rows) {
    const item = items.get(row.itemPk);
    if (item) units.push({ item, segment: row, fields: fieldsOf(item, row.content), tokenCount: row.tokenCount });
  }
  return units;
}

export function segmentsOf(db: DatabaseSync, itemPk: number): SegmentRow[] {
  return all<SegmentRow>(db, `SELECT ${SEGMENT_COLUMNS} FROM item_segments s WHERE s.item_pk = ? ORDER BY s.ordinal`, [itemPk]);
}

export function segmentCounts(db: DatabaseSync, itemPks: readonly number[]): Map<number, number> {
  if (itemPks.length === 0) return new Map();
  return new Map(all<{ itemPk: number; count: number }>(db, `SELECT item_pk AS itemPk, count(*) AS count FROM item_segments WHERE item_pk IN (${placeholders(itemPks)}) GROUP BY item_pk`, [...itemPks]).map((row) => [row.itemPk, row.count]));
}

function countOccurrences(text: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** 색인 토큰 기준의 출현 횟수. 구문은 연속 출현, 한글은 어간 부분 문자열, 그 밖은 접두 일치 단어 수다. */
export function termFrequency(term: QueryTerm, text: string): number {
  if (term.words) {
    const words = wordsOf(text);
    let count = 0;
    for (let start = 0; start + term.words.length <= words.length; start++) if (term.words.every((word, offset) => words[start + offset] === word)) count++;
    return count;
  }
  if (term.hangul) return countOccurrences(foldKey(text), term.stem);
  return wordsOf(text).filter((word) => word.startsWith(term.surface)).length;
}

function termKey(term: QueryTerm): string {
  return term.words ? `phrase:${term.words.join(' ')}` : `${term.hangul ? 'hangul' : 'word'}:${term.surface}:${term.stem}`;
}

/**
 * BM25 통계. 단위 수, 평균 길이, 문서 빈도를 모두 선택한 세대의 유효 범위 안에서만 센다.
 * 종류·상태·문서 필터와 작업 적용 조건은 통계에 넣지 않으므로, 같은 세대·같은 범위면 필터가 달라도 점수 척도가 같다.
 * 다른 세대, GC, 범위 밖 프로젝트의 변경은 이 값에 닿지 않는다. 내장 bm25()는 세대가 섞인 FTS 표 전체로 통계를 내므로 쓰지 않는다.
 */
export class Bm25Corpus {
  private readonly db: DatabaseSync;
  private readonly scope: SqlPredicate;
  private readonly segments: boolean;
  private readonly config: Bm25Config;
  private readonly frequencies = new Map<string, number>();
  private size: { units: number; averageLength: number } | null = null;

  constructor(db: DatabaseSync, scope: SqlPredicate, segments: boolean, config: Bm25Config) {
    this.db = db;
    this.scope = scope;
    this.segments = segments;
    this.config = config;
  }

  private scoped(condition: string): string {
    return `SELECT i.item_pk FROM ${ITEM_SOURCE} WHERE ${this.scope.sql}${condition === '' ? '' : ` AND ${condition}`}`;
  }

  get stats(): { units: number; averageLength: number } {
    if (this.size) return this.size;
    const itemCondition = this.segments ? UNSPLIT : '';
    const items = all<{ n: number; total: number | null; known: number }>(this.db, `SELECT count(*) AS n, sum(i.token_count) AS total, count(i.token_count) AS known FROM ${ITEM_SOURCE} WHERE ${this.scope.sql}${itemCondition ? ` AND ${itemCondition}` : ''}`, this.scope.params)[0]!;
    let total = items.total ?? 0;
    if (items.known < items.n) {
      for (const item of selectItems(this.db, this.scope, { sql: `i.token_count IS NULL${itemCondition ? ` AND ${itemCondition}` : ''}`, params: [] })) total += tokenCountOf(item);
    }
    let units = items.n;
    if (this.segments) {
      const segments = all<{ n: number; total: number | null }>(this.db, `SELECT count(*) AS n, sum(s.token_count) AS total FROM item_segments s WHERE s.item_pk IN (${this.scoped('')})`, this.scope.params)[0]!;
      units += segments.n;
      total += segments.total ?? 0;
    }
    this.size = { units, averageLength: units === 0 ? 0 : total / units };
    return this.size;
  }

  documentFrequency(term: QueryTerm): number {
    const key = termKey(term);
    const cached = this.frequencies.get(key);
    if (cached !== undefined) return cached;
    const match = buildMatch([term]);
    const itemCondition = `i.item_pk IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)${this.segments ? ` AND ${UNSPLIT}` : ''}`;
    let frequency = all<{ n: number }>(this.db, `SELECT count(*) AS n FROM ${ITEM_SOURCE} WHERE ${this.scope.sql} AND ${itemCondition}`, [...this.scope.params, match])[0]!.n;
    if (this.segments) {
      frequency += all<{ n: number }>(this.db, `SELECT count(*) AS n FROM item_segments s WHERE s.item_pk IN (${this.scoped('')}) AND s.segment_pk IN (SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?)`, [...this.scope.params, match])[0]!.n;
    }
    this.frequencies.set(key, frequency);
    return frequency;
  }

  idf(term: QueryTerm): number {
    const { units } = this.stats;
    const df = this.documentFrequency(term);
    return Math.log(1 + (units - df + 0.5) / (df + 0.5));
  }

  /** 0 이상 1 미만으로 정규화한 점수. 모든 항이 무한히 자주 나올 때의 상한으로 나눈다. */
  score(unit: SearchUnit, terms: readonly QueryTerm[]): number {
    const { k1, b, fieldWeights } = this.config;
    const { averageLength } = this.stats;
    const norm = averageLength === 0 ? 1 : 1 - b + (b * unit.tokenCount) / averageLength;
    let sum = 0;
    let ceiling = 0;
    for (const term of terms) {
      const idf = this.idf(term);
      ceiling += idf * (k1 + 1);
      let tf = 0;
      for (const field of SEARCH_FIELDS) tf += fieldWeights[field] * termFrequency(term, unit.fields[field]);
      if (tf > 0) sum += (idf * tf * (k1 + 1)) / (tf + k1 * norm);
    }
    return ceiling === 0 ? 0 : sum / ceiling;
  }
}
