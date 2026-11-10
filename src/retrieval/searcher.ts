import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { EFFECTIVE_STATUSES, KINDS, PHASES, type EffectiveStatus, type Kind, type Phase } from '../model.js';
import { bm25Of, queryLimitsOf, type ProfileConfig, type RankingConfig, type RetrievalConfig } from '../profiles/config.js';
import { compareStrings } from '../util/compare.js';
import { sha256 as sha256Hex } from '../util/hash.js';
import { pathsOverlap } from '../util/glob.js';
import { normalizeRepoPath } from '../util/paths.js';
import { composeSearch, sliceWholeCharacters, type PickedItem, type SearchFindings } from './compose.js';
import { composeSearchV2 } from './compose-v2.js';
import { foldKey, keyCandidates, parseQueryTerms, termMatches, type QueryTerm } from './query.js';
import {
  inEffectiveScope,
  parseScope,
  primaryProjects,
  selectItemIds,
  selectItems,
  sharedPredicate,
  versionSchema,
  versionSchemaV2,
  withGeneration,
  type EffectiveScope,
  type RequestedScope,
  type ScopedItem,
  type SqlPredicate,
  type VersionSelector,
} from './scope.js';
import type { Limitation, ProfileName, ResultGroup, RetrievalContext, SearchRequest, SearchRequestV2, SearchResponse, SearchResponseV2 } from './types.js';
import { RESULT_GROUPS } from './types.js';
import { Bm25Corpus, matchingUnits, SEARCH_FIELDS, type SearchUnit, type SegmentRow } from './units.js';

export const RANKER_VERSIONS = { legacy: 'keyword-legacy-1', bm25: 'keyword-bm25-2' } as const;
export const QUERY_VERSION = 'query-2';
const QUERY_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const V2_ONLY_FIELDS = ['queries', 'overflow', 'ranker', 'segments', 'include', 'quota', 'budget'] as const;

const commonFields = {
  profile: z.enum(['master', 'code']),
  query: z.string().optional(),
  scope: z.unknown(),
  task: z.strictObject({ phase: z.enum(PHASES).optional(), paths: z.array(z.string().min(1)).optional() }).optional(),
  limit: z.number().int().min(1).max(50).optional(),
};
const kindsFilter = z.array(z.enum(KINDS)).min(1).optional();
const statusesFilter = z.array(z.enum(EFFECTIVE_STATUSES)).min(1).optional();

const requestSchema = z.strictObject({
  ...commonFields,
  responseVersion: z.literal(1).optional(),
  filters: z.strictObject({ kinds: kindsFilter, statuses: statusesFilter }).optional(),
  version: versionSchema.optional(),
});

const requestSchemaV2 = z.strictObject({
  ...commonFields,
  responseVersion: z.literal(2),
  filters: z.strictObject({ kinds: kindsFilter, statuses: statusesFilter, documents: z.array(z.string().min(1)).min(1).max(256).optional() }).optional(),
  version: versionSchemaV2.optional(),
  queries: z.array(z.union([z.string().min(1), z.strictObject({ key: z.string().regex(QUERY_KEY).optional(), text: z.string().min(1) })])).min(1).optional(),
  overflow: z.enum(['error', 'truncate']).optional(),
  ranker: z.enum(['legacy', 'bm25']).optional(),
  segments: z.boolean().optional(),
  include: z.strictObject({ mandatory: z.boolean().optional(), dependencies: z.boolean().optional(), links: z.boolean().optional() }).optional(),
  quota: z.strictObject({ maxPerProject: z.number().int().min(1).optional(), minPerKind: z.partialRecord(z.enum(KINDS), z.number().int().min(1).max(50)).optional() }).optional(),
  budget: z
    .strictObject({
      maxItems: z.number().int().min(1).optional(),
      maxExcerptChars: z.number().int().min(1).optional(),
      maxResponseBytes: z.number().int().min(4096).optional(),
      priority: z
        .array(z.enum(RESULT_GROUPS as [ResultGroup, ...ResultGroup[]]))
        .length(RESULT_GROUPS.length)
        .refine((groups) => new Set(groups).size === groups.length, { message: 'priority must list every group once' })
        .optional(),
    })
    .optional(),
});

const DEFAULT_STATUSES = EFFECTIVE_STATUSES.filter((status) => status !== 'deprecated');

export interface QuerySpec {
  key: string;
  text: string;
  terms: QueryTerm[];
  /** 정규화하면 이 질의와 같아 합친 다른 질의의 키. */
  aliases: string[];
}

interface ParsedRequest {
  responseVersion: 1 | 2;
  profile: ProfileName;
  query: string | null;
  /** 검색할 항이 있는 질의만 담는다. */
  queries: QuerySpec[];
  echoQueries: SearchResponseV2['request']['queries'];
  scope: RequestedScope;
  kinds: Kind[] | null;
  statuses: EffectiveStatus[] | null;
  documents: { project: string; path: string }[] | null;
  documentEcho: string[] | null;
  version: VersionSelector;
  phase: Phase | null;
  /** 프로젝트별 작업 경로. 키는 scope.projects의 프로젝트뿐이다. */
  paths: Map<string, string[]>;
  limit: number;
  ranker: 'legacy' | 'bm25';
  segments: boolean;
  include: { mandatory: boolean; dependencies: boolean; links: boolean };
  quota: NonNullable<SearchRequestV2['quota']> | null;
  budget: NonNullable<SearchRequestV2['budget']> | null;
  /** 질의 가공에서 생긴 제한. 응답 형식 2에만 실린다. */
  notes: Limitation[];
}

function invalidRequest(message: string, detail: Record<string, unknown>): KnowledgeError {
  return new KnowledgeError('invalid-request', message, detail);
}

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** known은 접두사로 받을 프로젝트다. 문서 필터는 허용 연결 프로젝트도 받는다. 접두사가 없을 때의 기본은 언제나 projects의 첫째다. */
function qualifiedPaths(raw: readonly string[], projects: readonly string[], reasonPrefix: string, known: readonly string[] = projects): { project: string; path: string; input: string }[] {
  return raw.map((input) => {
    const colon = input.indexOf(':');
    const prefix = colon > 0 ? input.slice(0, colon) : '';
    const qualified = known.includes(prefix);
    if (projects.length > 1 && !qualified) throw invalidRequest('프로젝트가 여럿이면 작업 경로는 <project>:<path> 형식이어야 합니다', { reason: `unqualified-${reasonPrefix}`, path: input });
    const rest = qualified ? input.slice(colon + 1) : input;
    const path = normalizeRepoPath(rest);
    if (path === null) throw invalidRequest('작업 경로는 저장소 기준 상대 경로여야 합니다', { reason: `invalid-${reasonPrefix}`, path: input });
    // 디렉터리 필터는 끝의 `/`로 구분하므로 정규화가 지운 경우 다시 붙인다
    return { project: qualified ? prefix : projects[0]!, path: rest.endsWith('/') && !path.endsWith('/') ? `${path}/` : path, input };
  });
}

function taskPaths(raw: readonly string[], projects: readonly string[]): Map<string, string[]> {
  const parsed = qualifiedPaths(raw, projects, 'path');
  return new Map([...Map.groupBy(parsed, (entry) => entry.project)].map(([project, entries]) => [project, [...new Set(entries.map((entry) => entry.path))].sort(compareStrings)]));
}

function responseVersionOf(raw: unknown): 1 | 2 {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).responseVersion : undefined;
  if (value === undefined || value === 1) return 1;
  if (value === 2) return 2;
  throw invalidRequest('지원하지 않는 응답 형식입니다', { reason: 'unsupported-response-version', requested: value, supported: [1, 2] });
}

/** 응답 형식 2의 필드를 기존 형식 요청에 넣으면 무시하지 않고 거부한다. 조용히 버리면 호출자가 기능이 적용되었다고 믿는다. */
function assertNoV2Fields(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const record = raw as Record<string, unknown>;
  const fields: string[] = V2_ONLY_FIELDS.filter((field) => Object.hasOwn(record, field));
  const filters = record.filters as Record<string, unknown> | undefined;
  if (typeof filters === 'object' && filters !== null && Object.hasOwn(filters, 'documents')) fields.push('filters.documents');
  const version = record.version as Record<string, unknown> | undefined;
  if (typeof version === 'object' && version !== null) for (const field of ['indexId', 'exact']) if (Object.hasOwn(version, field)) fields.push(`version.${field}`);
  if (fields.length > 0) throw invalidRequest('이 필드는 responseVersion 2 요청에서만 쓸 수 있습니다', { reason: 'response-version-2-required', fields });
}

function normalizedQuery(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

interface QueryPlan {
  queries: QuerySpec[];
  echo: ParsedRequest['echoQueries'];
  notes: Limitation[];
}

/** 응답 형식 2의 질의 목록을 만든다. 키 후보·항 분석·되돌려 주는 원문은 원래 글을 쓰고, 정규화한 글은 중복 판정에만 쓴다. */
function planQueries(query: string | undefined, entries: SearchRequestV2['queries'], overflow: 'error' | 'truncate', retrieval: RetrievalConfig): QueryPlan {
  const limits = queryLimitsOf(retrieval);
  const notes: Limitation[] = [];
  let raw: { key: string; text: string }[] = [];
  if (query !== undefined && query.trim() !== '') raw.push({ key: 'query', text: query });
  (entries ?? []).forEach((entry, index) => raw.push(typeof entry === 'string' ? { key: `q${index + 1}`, text: entry } : { key: entry.key ?? `q${index + 1}`, text: entry.text }));

  const seenKeys = new Set<string>();
  for (const { key } of raw) {
    if (seenKeys.has(key)) throw invalidRequest('질의 키가 중복되었습니다', { reason: 'duplicate-query-key', key });
    seenKeys.add(key);
  }
  if (raw.length > limits.maxQueries) {
    if (overflow === 'error') throw invalidRequest('질의가 너무 많습니다', { reason: 'too-many-queries', count: raw.length, max: limits.maxQueries });
    notes.push({ code: 'queries-truncated', message: '질의 수가 상한을 넘어 뒤쪽 질의를 쓰지 않았습니다', detail: { droppedKeys: raw.slice(limits.maxQueries).map((entry) => entry.key), max: limits.maxQueries } });
    raw = raw.slice(0, limits.maxQueries);
  }
  const shortened: Record<string, number> = {};
  raw = raw.map((entry) => {
    if (entry.text.length <= limits.maxQueryChars) return entry;
    if (overflow === 'error') throw invalidRequest('질의가 너무 깁니다', { reason: 'query-too-long', key: entry.key, chars: entry.text.length, max: limits.maxQueryChars });
    shortened[entry.key] = entry.text.length;
    return { ...entry, text: sliceWholeCharacters(entry.text, 0, limits.maxQueryChars) };
  });
  if (Object.keys(shortened).length > 0) notes.push({ code: 'query-text-truncated', message: '상한보다 긴 질의의 뒷부분을 쓰지 않았습니다', detail: { chars: shortened, max: limits.maxQueryChars } });

  const kept = new Map<string, QuerySpec>();
  const echo: ParsedRequest['echoQueries'] = [];
  const duplicates: Record<string, string[]> = {};
  const termsCut: Record<string, number> = {};
  const workCut: string[] = [];
  let totalTerms = 0;
  for (const entry of raw) {
    const normal = normalizedQuery(entry.text);
    const first = kept.get(normal);
    const chars = entry.text.length;
    const digest = sha256Hex(entry.text);
    if (first) {
      first.aliases.push(entry.key);
      (duplicates[first.key] ??= []).push(entry.key);
      echo.push({ key: entry.key, chars, sha256: digest, duplicateOf: first.key });
      continue;
    }
    let terms = parseQueryTerms(entry.text);
    if (terms.length > limits.maxTermsPerQuery) {
      termsCut[entry.key] = terms.length;
      terms = terms.slice(0, limits.maxTermsPerQuery);
    }
    const room = Math.max(limits.maxTotalTerms - totalTerms, 0);
    if (terms.length > room) {
      workCut.push(entry.key);
      terms = terms.slice(0, room);
    }
    totalTerms += terms.length;
    const spec: QuerySpec = { key: entry.key, text: entry.text, terms, aliases: [] };
    kept.set(normal, spec);
    echo.push({ key: entry.key, chars, sha256: digest, duplicateOf: null });
  }
  if (Object.keys(duplicates).length > 0) notes.push({ code: 'queries-deduplicated', message: '같은 내용의 질의를 하나로 합쳤습니다', detail: { duplicates } });
  if (Object.keys(termsCut).length > 0) notes.push({ code: 'query-terms-truncated', message: '검색어가 많은 질의는 앞쪽 검색어만 썼습니다', detail: { terms: termsCut, max: limits.maxTermsPerQuery } });
  if (workCut.length > 0) notes.push({ code: 'query-work-truncated', message: '요청 전체의 검색어 수가 상한을 넘어 뒤쪽 질의의 검색어를 줄였습니다', detail: { keys: workCut, max: limits.maxTotalTerms } });
  return { queries: [...kept.values()].filter((spec) => spec.terms.length > 0), echo, notes };
}


function parseRequest(raw: unknown, retrieval: RetrievalConfig): ParsedRequest {
  const responseVersion = responseVersionOf(raw);
  if (responseVersion === 1) {
    assertNoV2Fields(raw);
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) throw invalidRequest('검색 요청의 형식이 올바르지 않습니다', { issues: issuesOf(parsed.error) });
    const { profile, query, filters, version, task, limit } = parsed.data;
    const profileConfig = retrieval.profiles[profile];
    const scope = parseScope(parsed.data.scope, profileConfig);
    const paths = taskPaths(task?.paths ?? [], scope.projects);
    const terms = parseQueryTerms(query ?? '');
    if (terms.length === 0 && paths.size === 0) throw invalidRequest('검색할 단어가 없습니다', { reason: 'no-searchable-terms' });
    const kept = query?.trim() ? query : null;
    return {
      responseVersion,
      profile,
      query: kept,
      queries: kept !== null && terms.length > 0 ? [{ key: 'query', text: kept, terms, aliases: [] }] : [],
      echoQueries: [],
      scope,
      kinds: filters?.kinds ? [...new Set(filters.kinds)].sort(compareStrings) : null,
      statuses: filters?.statuses ? [...new Set(filters.statuses)].sort(compareStrings) : null,
      documents: null,
      documentEcho: null,
      version: version ?? {},
      phase: task?.phase ?? null,
      paths,
      limit: limit ?? profileConfig.limit,
      ranker: 'legacy',
      segments: false,
      include: { mandatory: true, dependencies: true, links: true },
      quota: null,
      budget: null,
      notes: [],
    };
  }

  const parsed = requestSchemaV2.safeParse(raw);
  if (!parsed.success) throw invalidRequest('검색 요청의 형식이 올바르지 않습니다', { issues: issuesOf(parsed.error) });
  const data = parsed.data;
  const profileConfig = retrieval.profiles[data.profile];
  const scope = parseScope(data.scope, profileConfig);
  const paths = taskPaths(data.task?.paths ?? [], scope.projects);
  const plan = planQueries(data.query, data.queries, data.overflow ?? 'error', retrieval);
  if (plan.queries.length === 0 && paths.size === 0) throw invalidRequest('검색할 단어가 없습니다', { reason: 'no-searchable-terms' });
  const documentFilter = data.filters?.documents;
  const documents = documentFilter ? qualifiedPaths(documentFilter, scope.projects, 'document', [...scope.projects, ...scope.links.map((link) => link.project)]) : null;
  return {
    responseVersion,
    profile: data.profile,
    query: data.query?.trim() ? data.query : null,
    queries: plan.queries,
    echoQueries: plan.echo,
    scope,
    kinds: data.filters?.kinds ? [...new Set(data.filters.kinds)].sort(compareStrings) : null,
    statuses: data.filters?.statuses ? [...new Set(data.filters.statuses)].sort(compareStrings) : null,
    // 정규화 뒤 같은 문서는 하나로 합친다. 겹친 항목이 appliedScope와 digests.request만 바꾸지 않게 한다
    documents: documents ? [...new Map(documents.map(({ project, path }) => [`${project}\0${path}`, { project, path }])).values()].sort((a, b) => compareStrings(a.project, b.project) || compareStrings(a.path, b.path)) : null,
    documentEcho: documentFilter ? [...documentFilter] : null,
    version: data.version ?? {},
    phase: data.task?.phase ?? null,
    paths,
    limit: data.limit ?? profileConfig.limit,
    ranker: data.ranker ?? 'legacy',
    segments: data.segments ?? false,
    include: { mandatory: data.include?.mandatory ?? true, dependencies: data.include?.dependencies ?? true, links: data.include?.links ?? true },
    quota: data.quota ?? null,
    budget: data.budget ?? null,
    notes: plan.notes,
  };
}

interface SearchState {
  db: DatabaseSync;
  scope: EffectiveScope;
  request: ParsedRequest;
  profile: ProfileConfig;
  ranking: RankingConfig;
  applicabilityExcluded: Set<string>;
  segments: boolean;
  corpus: Bm25Corpus | null;
}

function isPrimary(state: SearchState, item: ScopedItem): boolean {
  return state.scope.projects.includes(item.projectId);
}

/** 허용 연결 항목에는 작업 단계·경로를 적용하지 않는다. */
function isApplicable(state: SearchState, item: ScopedItem): boolean {
  if (!isPrimary(state, item)) return true;
  const { phase, paths } = state.request;
  const { appliesTo } = item;
  if (phase !== null && appliesTo.phases.length > 0 && !appliesTo.phases.includes(phase)) return false;
  const provided = paths.get(item.projectId);
  if (!provided || appliesTo.global || appliesTo.paths.length === 0) return true;
  return provided.some((path) => appliesTo.paths.some((itemPath) => pathsOverlap(path, itemPath)));
}

function applicableOnly(state: SearchState, items: readonly ScopedItem[], excluded: Set<string> = state.applicabilityExcluded): ScopedItem[] {
  return items.filter((item) => {
    if (isApplicable(state, item)) return true;
    excluded.add(item.id);
    return false;
  });
}

function byDocumentOrder(a: ScopedItem, b: ScopedItem): number {
  return compareStrings(a.projectId, b.projectId) || compareStrings(a.sourceId, b.sourceId) || compareStrings(a.path, b.path) || a.ordinal - b.ordinal;
}

function sortedIds(items: readonly ScopedItem[]): string[] {
  return items.map((item) => item.id).sort(compareStrings);
}

/** 프로젝트를 번갈아 뽑아야 항목이 많은 프로젝트가 상한을 독차지하지 못한다. */
function roundRobin(items: readonly ScopedItem[], limit: number): { kept: ScopedItem[]; omitted: ScopedItem[] } {
  const queues = Map.groupBy(items, (item) => item.projectId);
  const kept = new Set<ScopedItem>();
  for (let round = 0; kept.size < limit && kept.size < items.length; round++) {
    for (const queue of queues.values()) {
      if (round < queue.length && kept.size < limit) kept.add(queue[round]!);
    }
  }
  return { kept: items.filter((item) => kept.has(item)), omitted: items.filter((item) => !kept.has(item)) };
}

const MANDATORY_CONDITION: SqlPredicate = { sql: "i.mandatory = 1 AND g.base_status NOT IN ('observed_behavior', 'deprecated')", params: [] };

function findMandatory(state: SearchState): { kept: ScopedItem[]; omitted: string[]; filtered: number } {
  const { db, scope, profile } = state;
  const predicate = sharedPredicate(scope, scope.statusesExplicit ? scope.statuses : null);
  const matches = applicableOnly(state, selectItems(db, predicate, MANDATORY_CONDITION)).sort(byDocumentOrder);
  const beforeFilters = applicableOnly(state, selectItems(db, inEffectiveScope(scope), MANDATORY_CONDITION), new Set()).length;
  const { kept, omitted } = roundRobin(matches, profile.mandatoryLimit);
  return { kept, omitted: sortedIds(omitted), filtered: beforeFilters - matches.length };
}

function findDependencies(state: SearchState, mandatory: readonly ScopedItem[]): { kept: ScopedItem[]; omitted: string[] } {
  const { db, scope, profile } = state;
  const primary = primaryProjects(scope);
  const condition = { sql: `${primary.sql} AND (i.kind = 'dependency' OR json_array_length(i.relations_json, '$.dependency') > 0)`, params: primary.params };
  const shown = new Set(mandatory.map((item) => item.id));
  const matches = applicableOnly(state, selectItems(db, sharedPredicate(scope), condition))
    .filter((item) => !shown.has(item.id))
    .sort(byDocumentOrder);
  const { kept, omitted } = roundRobin(matches, profile.dependencyLimit);
  return { kept, omitted: sortedIds(omitted) };
}

export interface DirectHit {
  item: ScopedItem;
  reasons: string[];
  terms: QueryTerm[];
  explicitKey: boolean;
  pathOverlap: boolean;
  keyHit: boolean;
  titleHit: boolean;
  /** 키워드로 찾지 않았으면 null이다. 질의가 여럿이면 가장 높은 값이다. */
  textScore: number | null;
  /** 가장 높은 점수를 낸 조각. 조각 단위를 쓰지 않았거나 나뉘지 않은 항목이면 null이다. */
  segment: SegmentRow | null;
  queries: string[];
}

interface TextMatch {
  unit: SearchUnit;
  terms: QueryTerm[];
  keyHit: boolean;
  titleHit: boolean;
  coverage: number;
  weightedHits: number;
}

function matchText(unit: SearchUnit, terms: readonly QueryTerm[], ranking: RankingConfig): TextMatch {
  const { fields } = unit;
  const matched: QueryTerm[] = [];
  let keyHit = false;
  let titleHit = false;
  let weightedHits = 0;
  for (const term of terms) {
    const hitFields = SEARCH_FIELDS.filter((field) => termMatches(term, fields[field]));
    if (hitFields.length === 0) continue;
    matched.push(term);
    keyHit ||= hitFields.includes('key_aliases');
    titleHit ||= hitFields.includes('title');
    weightedHits += hitFields.reduce((sum, field) => sum + ranking.fieldWeights[field], 0);
  }
  return { unit, terms: matched, keyHit, titleHit, coverage: matched.length / terms.length, weightedHits };
}

function pathMatches(state: SearchState, predicate: SqlPredicate): ScopedItem[] {
  const { db, scope, request } = state;
  const found = new Map<string, ScopedItem>();
  for (const [project, paths] of request.paths) {
    const marks = paths.map(() => '?').join(', ');
    for (const item of selectItems(db, predicate, { sql: `d.project_id = ? AND i.item_pk IN (SELECT item_pk FROM item_paths WHERE path IN (${marks}))`, params: [project, ...paths] })) found.set(item.id, item);
  }
  const primary = primaryProjects(scope);
  for (const item of selectItems(db, predicate, { sql: `${primary.sql} AND json_array_length(i.applies_to_json, '$.paths') > 0`, params: primary.params })) {
    const provided = request.paths.get(item.projectId);
    if (provided?.some((path) => item.appliesTo.paths.some((itemPath) => pathsOverlap(path, itemPath)))) found.set(item.id, item);
  }
  return [...found.values()];
}

interface RankedMatch {
  match: TextMatch;
  textScore: number;
}

/**
 * 한 질의의 키워드 후보를 순위대로 돌려준다. 기존 순위는 일치 비율·필드 가중 일치·순번을 쓰고, BM25는 범위 안 통계로 점수를 낸다.
 * 조각 단위면 단위마다 매긴 뒤 항목마다 가장 좋은 단위 하나만 남긴다.
 */
function keywordCandidates(state: SearchState, predicate: SqlPredicate, terms: readonly QueryTerm[], excluded: Set<string>, candidateLimit: number): { ranked: RankedMatch[]; total: number } {
  const { db, ranking } = state;
  const units = matchingUnits(db, predicate, terms, state.segments);
  const allowed = new Set(applicableOnly(state, [...new Map(units.map((unit) => [unit.item.id, unit.item])).values()], excluded).map((item) => item.id));
  const matches = units.filter((unit) => allowed.has(unit.item.id)).map((unit) => matchText(unit, terms, ranking));

  if (state.corpus === null) {
    // 조각 ID를 문자열로 비교하면 #10이 #2보다 앞선다. 항목 ID 다음 순번으로 비교한다. 조각을 쓰지 않으면 단위 ID가 항목 ID라 결과가 같다
    const sorted = matches.sort((a, b) => b.coverage - a.coverage || b.weightedHits - a.weightedHits || compareStrings(a.unit.item.id, b.unit.item.id) || (a.unit.segment?.ordinal ?? 0) - (b.unit.segment?.ordinal ?? 0));
    const best = new Map<string, TextMatch>();
    for (const match of sorted) if (!best.has(match.unit.item.id)) best.set(match.unit.item.id, match);
    const deduped = [...best.values()];
    const candidates = deduped.slice(0, candidateLimit);
    const count = candidates.length;
    return { ranked: candidates.map((match, position) => ({ match, textScore: 0.6 * match.coverage + 0.4 * (1 - position / Math.max(count, 1)) })), total: deduped.length };
  }

  const corpus = state.corpus;
  const scored = matches
    .map((match) => ({ match, textScore: corpus.score(match.unit, terms) }))
    .sort((a, b) => b.textScore - a.textScore || compareStrings(a.match.unit.item.id, b.match.unit.item.id) || (a.match.unit.segment?.ordinal ?? 0) - (b.match.unit.segment?.ordinal ?? 0));
  const best = new Map<string, RankedMatch>();
  for (const entry of scored) if (!best.has(entry.match.unit.item.id)) best.set(entry.match.unit.item.id, entry);
  const deduped = [...best.values()];
  return { ranked: deduped.slice(0, candidateLimit), total: deduped.length };
}

function mergeTerms(current: readonly QueryTerm[], added: readonly QueryTerm[]): QueryTerm[] {
  const seen = new Set(current.map((term) => term.surface));
  return [...current, ...added.filter((term) => !seen.has(term.surface) && seen.add(term.surface))];
}

interface DirectResult {
  hits: Map<string, DirectHit>;
  /** 질의별 후보 수와 전체 일치 수. */
  truncated: { key: string; total: number }[];
}

/** 명시적 키, 경로, 키워드로 직접 찾은 후보를 모은다. 폐기 자료 수를 셀 때도 같은 경로를 쓰도록 조건과 상한을 인자로 받는다. */
function findDirect(state: SearchState, predicate: SqlPredicate, excluded: Set<string>, candidateLimit: number): DirectResult {
  const { db, request } = state;
  const hits = new Map<string, DirectHit>();
  const hitFor = (item: ScopedItem): DirectHit => {
    let hit = hits.get(item.id);
    if (!hit) {
      hit = { item, reasons: [], terms: [], explicitKey: false, pathOverlap: false, keyHit: false, titleHit: false, textScore: null, segment: null, queries: [] };
      hits.set(item.id, hit);
    }
    return hit;
  };
  const addQuery = (hit: DirectHit, spec: QuerySpec): void => {
    for (const key of [spec.key, ...spec.aliases]) if (!hit.queries.includes(key)) hit.queries.push(key);
  };

  if (request.queries.length > 0) {
    const candidatesBySpec = request.queries.map((spec) => ({ spec, candidates: keyCandidates(spec.text) }));
    const all = new Set(candidatesBySpec.flatMap(({ candidates }) => [...candidates]));
    const keyed = selectItems(db, predicate, { sql: "(i.key IS NOT NULL OR i.aliases_json <> '[]')", params: [] }).filter((item) => [item.key, ...item.aliases].some((value) => value !== null && all.has(foldKey(value))));
    for (const item of applicableOnly(state, keyed, excluded)) {
      const hit = hitFor(item);
      hit.explicitKey = true;
      hit.reasons.push('explicit-key');
      const folded = [item.key, ...item.aliases].flatMap((value) => (value === null ? [] : [foldKey(value)]));
      for (const { spec, candidates } of candidatesBySpec) if (folded.some((value) => candidates.has(value))) addQuery(hit, spec);
    }
  }

  if (request.paths.size > 0) {
    for (const item of applicableOnly(state, pathMatches(state, predicate), excluded)) {
      const hit = hitFor(item);
      hit.pathOverlap = true;
      hit.reasons.push('path-overlap');
    }
  }

  const truncated: DirectResult['truncated'] = [];
  for (const spec of request.queries) {
    const { ranked, total } = keywordCandidates(state, predicate, spec.terms, excluded, candidateLimit);
    if (total > ranked.length) truncated.push({ key: spec.key, total });
    for (const { match, textScore } of ranked) {
      const hit = hitFor(match.unit.item);
      if (!hit.reasons.includes('keyword-match')) hit.reasons.push('keyword-match');
      hit.terms = mergeTerms(hit.terms, match.terms);
      hit.keyHit ||= match.keyHit;
      hit.titleHit ||= match.titleHit;
      if (hit.textScore === null || textScore > hit.textScore) {
        hit.textScore = textScore;
        hit.segment = match.unit.segment;
      }
      addQuery(hit, spec);
    }
  }
  return { hits, truncated };
}

function scoreOf(state: SearchState, hit: DirectHit): number {
  const { fieldBoosts, statusWeights } = state.ranking;
  const { item } = hit;
  const textScore = hit.textScore ?? 0;
  // BM25는 필드 가중치로 키·제목 일치를 이미 반영한다. 0~1로 줄인 점수에 낱말 하나만 맞아도 붙는 가산점을 더하면
  // 같은 일치를 두 번 세고, 점수 척도가 작아 가산점이 순위를 정해 버린다. 경로 겹침과 명시적 키는 글 일치가 아니므로 둔다
  const textBoosts = state.corpus === null ? (hit.keyHit ? fieldBoosts.keyOrAlias : 0) + (hit.titleHit ? fieldBoosts.title : 0) : 0;
  const boosts = textBoosts + (hit.pathOverlap ? fieldBoosts.pathOverlap : 0) + (hit.explicitKey ? fieldBoosts.explicitKey : 0);
  const phaseWeight = state.request.phase !== null && isPrimary(state, item) ? state.profile.phaseWeights?.[state.request.phase]?.[item.kind] : undefined;
  return (textScore + boosts) * (phaseWeight ?? state.profile.kindWeights[item.kind]) * statusWeights[item.effectiveStatus];
}

/** 대상이 공통 조건을 통과하지 못하면 그 너머로도 따라가지 않는다. */
function expandLinks(state: SearchState, seeds: readonly ScopedItem[], sectionOf: (item: ScopedItem) => string): { linked: PickedItem[]; omitted: string[] } {
  const { db, scope, profile } = state;
  const predicate = sharedPredicate(scope);
  const targets = new Map<string, ScopedItem | undefined>();
  const admit = (id: string): ScopedItem | undefined => {
    if (!targets.has(id)) targets.set(id, applicableOnly(state, selectItems(db, predicate, { sql: 'i.item_id = ?', params: [id] }))[0]);
    return targets.get(id);
  };

  const included = new Set(seeds.map((item) => item.id));
  const linked: PickedItem[] = [];
  const omitted = new Set<string>();
  const queue = seeds.map((item) => ({ item, depth: 0 }));
  for (let index = 0; index < queue.length; index++) {
    const { item, depth } = queue[index]!;
    if (depth >= profile.linkDepth) continue;
    for (const link of item.links) {
      if (link.kind !== 'item' || !link.resolved || included.has(link.targetItemId!)) continue;
      const target = admit(link.targetItemId!);
      if (!target) continue;
      if (linked.length >= profile.linkLimit) {
        omitted.add(target.id);
        continue;
      }
      included.add(target.id);
      linked.push({ item: target, section: sectionOf(target), score: 0, reasons: [`linked:${link.relation}:${item.id}`], terms: [] });
      queue.push({ item: target, depth: depth + 1 });
    }
  }
  return { linked, omitted: [...omitted].sort(compareStrings) };
}

interface Scored {
  hit: DirectHit;
  score: number;
}

/**
 * 직접 결과를 고른다. 종류별 최소 수를 먼저 그 종류의 일치 후보에서 채우고(일치하지 않는 자료로 채우지 않는다),
 * 남은 자리를 점수순으로 채운다. 프로젝트별 상한은 두 단계 모두에 적용한다. 최종 순서는 점수순이다.
 */
function applyQuota(ranked: readonly Scored[], limit: number, quota: NonNullable<ParsedRequest['quota']>): { selected: Scored[]; unmet: Record<string, { required: number; selected: number }> } {
  const chosen = new Set<Scored>();
  const perProject = new Map<string, number>();
  const take = (entry: Scored): boolean => {
    if (chosen.size >= limit || chosen.has(entry)) return false;
    const project = entry.hit.item.projectId;
    if (quota.maxPerProject !== undefined && (perProject.get(project) ?? 0) >= quota.maxPerProject) return false;
    chosen.add(entry);
    perProject.set(project, (perProject.get(project) ?? 0) + 1);
    return true;
  };
  const unmet: Record<string, { required: number; selected: number }> = {};
  for (const kind of Object.keys(quota.minPerKind ?? {}).sort(compareStrings) as Kind[]) {
    const required = quota.minPerKind![kind]!;
    let selected = 0;
    for (const entry of ranked) {
      if (selected >= required) break;
      if (entry.hit.item.kind === kind && take(entry)) selected++;
    }
    if (selected < required) unmet[kind] = { required, selected };
  }
  for (const entry of ranked) take(entry);
  return { selected: ranked.filter((entry) => chosen.has(entry)), unmet };
}

function pickOf(entry: Scored, section: string, directRank: number): PickedItem {
  const { hit, score } = entry;
  return { item: hit.item, section, score, reasons: hit.reasons, terms: hit.terms, group: 'direct', segment: hit.segment, queries: hit.queries, directRank };
}

/** 기존 형식(v1) 라이브러리 진입점. 형식이 고정되어야 기존 소비자의 타입이 깨지지 않으므로 형식 2 요청은 searchV2로 보낸다. */
export function search(context: RetrievalContext, raw: SearchRequest | unknown): SearchResponse {
  if (responseVersionOf(raw) === 2) throw invalidRequest('responseVersion 2 요청은 searchV2로 보내 주십시오', { reason: 'use-search-v2' });
  return searchAny(context, raw) as SearchResponse;
}

export function searchV2(context: RetrievalContext, raw: SearchRequestV2 | unknown): SearchResponseV2 {
  if (responseVersionOf(raw) !== 2) throw invalidRequest('searchV2에는 responseVersion 2 요청만 보낼 수 있습니다', { reason: 'response-version-2-required', fields: ['responseVersion'] });
  return searchAny(context, raw) as SearchResponseV2;
}

/** 형식을 모르는 요청(JSON 파일, CLI)을 받는다. 응답 형식은 요청의 responseVersion을 따른다. */
export function searchAny(context: RetrievalContext, raw: unknown): SearchResponse | SearchResponseV2 {
  const request = parseRequest(raw, context.retrieval);
  const profile = context.retrieval.profiles[request.profile];
  const ranking = context.retrieval.ranking;
  const v2 = request.responseVersion === 2;

  return withGeneration(
    context,
    request.scope,
    request.version,
    (db, selected) => {
      const scope: EffectiveScope = {
        ...request.scope,
        generation: selected.generation,
        kinds: request.kinds,
        statuses: request.statuses ?? DEFAULT_STATUSES,
        statusesExplicit: request.statuses !== null,
        ...(v2 ? { documents: request.documents } : {}),
      };
      // 조각이 없는 옛 세대에서는 조각 단위를 켜도 항목 단위와 같다
      const segments = request.segments && selected.parserVersion !== 'md-1';
      const corpus = request.ranker === 'bm25' ? new Bm25Corpus(db, inEffectiveScope(scope), segments, bm25Of(ranking)) : null;
      const state: SearchState = { db, scope, request, profile, ranking, applicabilityExcluded: new Set(), segments, corpus };
      const sectionByKind = new Map(profile.sections.flatMap((section) => section.kinds.map((kind) => [kind, section.id] as const)));
      const sectionOf = (item: ScopedItem): string => sectionByKind.get(item.kind)!;
      const supplementary = (section: string, reason: string, group: ResultGroup) => (item: ScopedItem): PickedItem => ({ item, section, score: 0, reasons: [reason], terms: [], ...(v2 ? { group, queries: absorbed.get(item.id)?.queries ?? [] } : {}) });

      const mandatory = request.include.mandatory ? findMandatory(state) : { kept: [], omitted: [], filtered: 0 };
      const dependencies = request.include.dependencies ? findDependencies(state, mandatory.kept) : { kept: [], omitted: [] };
      const shown = new Set([...mandatory.kept, ...dependencies.kept].map((item) => item.id));

      const { hits, truncated } = findDirect(state, sharedPredicate(scope), state.applicabilityExcluded, ranking.candidateLimit);
      // 이미 필수·의존 묶음에 든 일치 항목은 직접 결과에 다시 넣지 않는다. 형식 2는 일치했다는 사실을 그 항목과 outcome에 남긴다
      const absorbed = new Map([...hits.values()].filter((hit) => shown.has(hit.item.id)).map((hit) => [hit.item.id, hit]));
      const scored = [...hits.values()]
        .filter((hit) => !shown.has(hit.item.id))
        .map((hit): Scored => ({ hit, score: scoreOf(state, hit) }))
        .sort((a, b) => b.score - a.score || compareStrings(a.hit.item.id, b.hit.item.id));
      const quota = request.quota ? applyQuota(scored, request.limit, request.quota) : { selected: scored.slice(0, request.limit), unmet: {} };
      const ranked = quota.selected.map((entry, index): PickedItem => (v2 ? pickOf(entry, sectionOf(entry.hit.item), index + 1) : { item: entry.hit.item, section: sectionOf(entry.hit.item), score: entry.score, reasons: entry.hit.reasons, terms: entry.hit.terms }));

      const mandatoryPicks = mandatory.kept.map(supplementary('mandatory', 'mandatory', 'mandatory'));
      const dependencyPicks = dependencies.kept.map(supplementary('dependencies', 'explicit-dependency', 'dependencies'));
      const seeds = [...mandatoryPicks, ...dependencyPicks, ...ranked].map((pick) => pick.item);
      const links = request.include.links ? expandLinks(state, seeds, sectionOf) : { linked: [], omitted: [] };
      const linked = v2 ? links.linked.map((pick) => ({ ...pick, group: 'linked' as const })) : links.linked;

      const deprecatedExcluded = scope.statuses.includes('deprecated') ? 0 : findDirect({ ...state, corpus: null }, sharedPredicate(scope, ['deprecated']), new Set(), Number.MAX_SAFE_INTEGER).hits.size;
      const widest = truncated.reduce((max, entry) => Math.max(max, entry.total), 0);
      const findings: SearchFindings = {
        mandatoryOmitted: mandatory.omitted,
        mandatoryFiltered: mandatory.filtered,
        dependenciesOmitted: dependencies.omitted,
        linksOmitted: links.omitted,
        candidatesTruncated: truncated.length === 0 ? null : { total: widest, limit: ranking.candidateLimit, ...(request.queries.length > 1 ? { queries: truncated.map((entry) => entry.key) } : {}) },
        deprecatedExcluded,
        applicabilityExcluded: state.applicabilityExcluded.size,
      };

      const taskPathList = [...request.paths].flatMap(([project, paths]) => paths.map((path) => (scope.projects.length > 1 ? `${project}:${path}` : path))).sort(compareStrings);
      const base = {
        context,
        request: { profile: request.profile, query: request.query, task: { phase: request.phase, paths: taskPathList }, limit: request.limit },
        scope,
        selected,
        profile,
        inScope: selectItemIds(db, inEffectiveScope(scope)),
        evaluated: (item: ScopedItem) => ({ phase: request.phase !== null && isPrimary(state, item), paths: isPrimary(state, item) && request.paths.has(item.projectId) }),
        mandatory: mandatoryPicks,
        dependencies: dependencyPicks,
        direct: ranked,
        linked,
        findings,
      };
      if (!v2) return composeSearch(base);

      const extraLimitations: Limitation[] = [...request.notes];
      if (Object.keys(quota.unmet).length > 0) extraLimitations.push({ code: 'quota-unmet', message: '종류별 최소 수를 채울 일치 자료가 부족합니다', detail: { kinds: quota.unmet } });
      if (selected.parserVersion === 'md-1') {
        extraLimitations.push({ code: 'generation-predates-v2', message: '이 세대는 조각·HTTP 작업·상태 표기 기록을 만들기 전에 색인되었습니다', detail: { parserVersion: selected.parserVersion, chunkerVersion: selected.chunkerVersion } });
      }
      return composeSearchV2({
        ...base,
        db,
        directMatched: scored.length,
        supplementaryMatched: absorbed.size,
        options: {
          echo: {
            queries: request.echoQueries,
            ranker: request.ranker,
            segments: request.segments,
            include: request.include,
            quota: request.quota,
            budget: request.budget,
            documents: request.documentEcho,
            version: request.version,
          },
          ranker: request.ranker,
          rankerVersion: RANKER_VERSIONS[request.ranker],
          queryVersion: QUERY_VERSION,
          segments: { requested: request.segments, effective: segments },
          budget: request.budget,
          queryNotes: request.notes,
          extraLimitations,
          retrieval: context.retrieval,
        },
      });
    },
    { requireCurrentSchema: v2 },
  );
}

