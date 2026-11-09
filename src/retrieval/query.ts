import { hangulBigrams, wordsOf, WORD_RUN } from '../parsing/tokenize.js';

const PARTICLES = ['에서는', '으로는', '에게서', '까지는', '부터는', '이라고', '에서', '에게', '으로', '까지', '부터', '라고', '처럼', '보다', '은', '는', '이', '가', '을', '를', '에', '의', '와', '과', '도', '만', '로'];
const SINGLE_PARTICLES = new Set(PARTICLES.filter((particle) => particle.length === 1));
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'with', '그리고', '또는', '및', '등', '대한', '위한', '어떻게', '무엇', '있는', '없는', '하는']);
const HANGUL_ONLY = /^[가-힣]+$/;
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
const WORD_COLUMNS = '{key_aliases title headings body}';
const NGRAM_COLUMNS = '{ngram_title ngram_body}';

export interface QueryTerm {
  surface: string;
  stem: string;
  hangul: boolean;
  /** 구문 항이면 연속으로 일치해야 할 단어들이다. */
  words: string[] | null;
}

export function foldKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function stripParticle(word: string): string {
  if (word.length < 3) return word;
  const particle = PARTICLES.find((candidate) => word.endsWith(candidate) && word.length - candidate.length >= 2);
  return particle ? word.slice(0, -particle.length) : word;
}

function wordTerm(word: string): QueryTerm {
  const hangul = HANGUL_ONLY.test(word);
  return { surface: word, stem: hangul ? stripParticle(word) : word, hangul, words: null };
}

/** 혼합 토큰은 조각마다 따로 찾아야 `API를`이 `api`로 검색된다. */
function piecesOf(fragment: string): string[] {
  return [...fragment.matchAll(WORD_RUN)].flatMap(([run]) => {
    const words = wordsOf(run);
    return words.length > 1 && words[0] === run.toLowerCase() ? words.slice(1) : words;
  });
}

function withoutTrailingParticle(words: string[]): string[] {
  return words.length > 2 && PARTICLES.includes(words.at(-1)!) ? words.slice(0, -1) : words;
}

export function parseQueryTerms(query: string): QueryTerm[] {
  const phrases: QueryTerm[] = [];
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const fragment of query.normalize('NFC').split(/\s+/).filter(Boolean)) {
    const words = wordsOf(fragment);
    if (fragment.includes('-') && words.length >= 2) {
      const phrase = withoutTrailingParticle(words);
      const surface = phrase.join(' ');
      phrases.push({ surface, stem: surface, hangul: false, words: phrase });
      continue;
    }
    for (const piece of piecesOf(fragment)) (STOPWORDS.has(piece) || SINGLE_PARTICLES.has(piece) ? dropped : kept).push(piece);
  }
  const words = phrases.length === 0 && kept.length === 0 ? dropped : kept;
  return [...new Map([...phrases, ...words.map(wordTerm)].map((term) => [term.surface, term])).values()];
}

function quote(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

/** 호출자는 terms가 비어 있으면 부르지 않는다. 빈 MATCH는 FTS5 구문 오류다. */
export function buildMatch(terms: readonly QueryTerm[]): string {
  return terms
    .map((term) => {
      if (term.words) return `(${WORD_COLUMNS}: ${quote(term.words.join(' '))})`;
      const forms = [...new Set([term.surface, term.stem])].map((form) => `${quote(form)}*`);
      const wordPart = `${WORD_COLUMNS}: (${forms.join(' OR ')})`;
      if (!term.hangul || term.stem.length < 2) return `(${wordPart})`;
      return `(${wordPart} OR ${NGRAM_COLUMNS}: ${quote(hangulBigrams(term.stem).join(' '))})`;
    })
    .join(' OR ');
}

function containsPhrase(words: readonly string[], phrase: readonly string[]): boolean {
  for (let start = 0; start + phrase.length <= words.length; start++) {
    if (phrase.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

export function termMatches(term: QueryTerm, text: string): boolean {
  if (term.words) return containsPhrase(wordsOf(text), term.words);
  if (term.hangul) {
    const folded = foldKey(text);
    return folded.includes(term.stem) || folded.includes(term.surface);
  }
  return wordsOf(text).some((word) => word.startsWith(term.surface));
}

/** 발췌 창의 중심을 잡는 용도다. 찾지 못하면 줄 맨 앞을 돌려준다. */
export function termOffset(term: QueryTerm, line: string): number {
  const folded = foldKey(line);
  const probe = term.words ? term.words[0]! : folded.includes(term.stem) ? term.stem : term.surface;
  return Math.max(folded.indexOf(probe), 0);
}

export function keyCandidates(query: string): Set<string> {
  const candidates = new Set([foldKey(query.trim())]);
  for (const fragment of query.split(/\s+/)) {
    const clean = fragment.replace(EDGE_PUNCTUATION, '');
    if (clean === '') continue;
    candidates.add(foldKey(clean));
    const particle = PARTICLES.find((candidate) => clean.endsWith(candidate) && clean.length > candidate.length);
    // 조사를 떼면 `BR-001`을 처럼 안쪽 문장 부호가 다시 가장자리로 나온다
    if (particle) candidates.add(foldKey(clean.slice(0, -particle.length).replace(EDGE_PUNCTUATION, '')));
  }
  candidates.delete('');
  return candidates;
}
