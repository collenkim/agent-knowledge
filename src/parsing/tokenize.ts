import type { ParsedItem } from '../model.js';

export const WORD_RUN = /[\p{L}\p{N}_]+/gu;
const HANGUL_BOUNDARY = /(?<=[가-힣])(?=[^가-힣])|(?<=[^가-힣])(?=[가-힣])/u;
const CAMEL_BOUNDARY = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;
const HANGUL_RUN = /[가-힣]{2,}/g;
const HANGUL_TAIL = /^([^가-힣]+)([가-힣]+)$/;
const RUN_SEPARATOR = 'zzsep';

function wordsOfRun(run: string): string[] {
  const pieces = run.split(HANGUL_BOUNDARY).flatMap((part) => part.split(CAMEL_BOUNDARY));
  return pieces.length > 1 ? [run.toLowerCase(), ...new Set(pieces.map((piece) => piece.toLowerCase()))] : [run.toLowerCase()];
}

export function wordsOf(text: string): string[] {
  const words: string[] = [];
  for (const [run] of text.normalize('NFC').matchAll(WORD_RUN)) {
    const tail = HANGUL_TAIL.exec(run);
    // `18을` 전체를 먼저 넣으면 앞 단어와 `18` 사이가 벌어져 `ORD-18` 구문 검색이 실패하므로 머리를 일반 실행처럼 처리하고 꼬리를 낸다
    if (tail) words.push(...wordsOfRun(tail[1]!), tail[2]!);
    else words.push(...wordsOfRun(run));
  }
  return words;
}

export function hangulBigrams(text: string): string[] {
  const grams: string[] = [];
  for (const [run] of text.normalize('NFC').matchAll(HANGUL_RUN)) {
    // 구분자가 없으면 서로 다른 어절의 바이그램이 구문 검색에서 이어져 보인다
    if (grams.length > 0) grams.push(RUN_SEPARATOR);
    for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2));
  }
  return grams;
}

type IndexableItem = Pick<ParsedItem, 'key' | 'aliases' | 'title' | 'headingPath' | 'content'>;

export function indexColumns(item: IndexableItem): Record<'key_aliases' | 'title' | 'headings' | 'body' | 'ngram_title' | 'ngram_body', string> {
  const headings = item.headingPath.join(' ');
  return {
    key_aliases: wordsOf([item.key ?? '', ...item.aliases].join(' ')).join(' '),
    title: wordsOf(item.title).join(' '),
    headings: wordsOf(headings).join(' '),
    body: wordsOf(item.content).join(' '),
    ngram_title: hangulBigrams(`${item.title} ${headings}`).join(' '),
    ngram_body: hangulBigrams(item.content).join(' '),
  };
}
