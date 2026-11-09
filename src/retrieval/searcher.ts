import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import { EFFECTIVE_STATUSES, KINDS, PHASES, type EffectiveStatus, type Kind, type Phase } from '../model.js';
import type { ProfileConfig, RankingConfig, RetrievalConfig } from '../profiles/config.js';
import { compareStrings } from '../util/compare.js';
import { pathsOverlap } from '../util/glob.js';
import { normalizeRepoPath } from '../util/paths.js';
import { composeSearch, type PickedItem, type SearchFindings } from './compose.js';
import { buildMatch, foldKey, keyCandidates, parseQueryTerms, termMatches, type QueryTerm } from './query.js';
import { inEffectiveScope, parseScope, primaryProjects, selectItemIds, selectItems, sharedPredicate, versionSchema, withGeneration, type EffectiveScope, type RequestedScope, type ScopedItem, type SqlPredicate } from './scope.js';
import type { ProfileName, RetrievalContext, SearchResponse, VersionRequest } from './types.js';

const requestSchema = z.strictObject({
  profile: z.enum(['master', 'code']),
  query: z.string().optional(),
  scope: z.unknown(),
  filters: z.strictObject({ kinds: z.array(z.enum(KINDS)).min(1).optional(), statuses: z.array(z.enum(EFFECTIVE_STATUSES)).min(1).optional() }).optional(),
  version: versionSchema.optional(),
  task: z.strictObject({ phase: z.enum(PHASES).optional(), paths: z.array(z.string().min(1)).optional() }).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const DEFAULT_STATUSES = EFFECTIVE_STATUSES.filter((status) => status !== 'deprecated');
const SEARCH_FIELDS = ['key_aliases', 'title', 'headings', 'body'] as const;

interface ParsedRequest {
  profile: ProfileName;
  query: string | null;
  terms: QueryTerm[];
  scope: RequestedScope;
  kinds: Kind[] | null;
  statuses: EffectiveStatus[] | null;
  version: VersionRequest;
  phase: Phase | null;
  /** 프로젝트별 작업 경로. 키는 scope.projects의 프로젝트뿐이다. */
  paths: Map<string, string[]>;
  limit: number;
}

function invalidRequest(message: string, detail: Record<string, unknown>): KnowledgeError {
  return new KnowledgeError('invalid-request', message, detail);
}

function taskPaths(raw: readonly string[], projects: readonly string[]): Map<string, string[]> {
  const parsed = raw.map((input) => {
    const colon = input.indexOf(':');
    const prefix = colon > 0 ? input.slice(0, colon) : '';
    const qualified = projects.includes(prefix);
    if (projects.length > 1 && !qualified) throw invalidRequest('프로젝트가 여럿이면 작업 경로는 <project>:<path> 형식이어야 합니다', { reason: 'unqualified-path', path: input });
    const path = normalizeRepoPath(qualified ? input.slice(colon + 1) : input);
    if (path === null) throw invalidRequest('작업 경로는 저장소 기준 상대 경로여야 합니다', { reason: 'invalid-path', path: input });
    return { project: qualified ? prefix : projects[0]!, path };
  });
  return new Map([...Map.groupBy(parsed, (entry) => entry.project)].map(([project, entries]) => [project, [...new Set(entries.map((entry) => entry.path))].sort(compareStrings)]));
}

function parseRequest(raw: unknown, retrieval: RetrievalConfig): ParsedRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw invalidRequest('검색 요청의 형식이 올바르지 않습니다', { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  const { profile, query, filters, version, task, limit } = parsed.data;
  const profileConfig = retrieval.profiles[profile];
  const scope = parseScope(parsed.data.scope, profileConfig);
  const paths = taskPaths(task?.paths ?? [], scope.projects);
  const terms = parseQueryTerms(query ?? '');
  if (terms.length === 0 && paths.size === 0) throw invalidRequest('검색할 단어가 없습니다', { reason: 'no-searchable-terms' });
  return {
    profile,
    query: query?.trim() ? query : null,
    terms,
    scope,
    kinds: filters?.kinds ? [...new Set(filters.kinds)].sort(compareStrings) : null,
    statuses: filters?.statuses ? [...new Set(filters.statuses)].sort(compareStrings) : null,
    version: version ?? {},
    phase: task?.phase ?? null,
    paths,
    limit: limit ?? profileConfig.limit,
  };
}

interface SearchState {
  db: DatabaseSync;
  scope: EffectiveScope;
  request: ParsedRequest;
  profile: ProfileConfig;
  ranking: RankingConfig;
  applicabilityExcluded: Set<string>;
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

interface DirectHit {
  item: ScopedItem;
  reasons: string[];
  terms: QueryTerm[];
  explicitKey: boolean;
  pathOverlap: boolean;
  keyHit: boolean;
  titleHit: boolean;
  coverage: number;
  position: number | null;
}

interface TextMatch {
  item: ScopedItem;
  terms: QueryTerm[];
  keyHit: boolean;
  titleHit: boolean;
  coverage: number;
  weightedHits: number;
}

function matchText(item: ScopedItem, terms: readonly QueryTerm[], ranking: RankingConfig): TextMatch {
  const fields = { key_aliases: [item.key ?? '', ...item.aliases].join(' '), title: item.title, headings: item.headingPath.join(' '), body: item.content };
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
  return { item, terms: matched, keyHit, titleHit, coverage: matched.length / terms.length, weightedHits };
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

/** 명시적 키, 경로, 키워드로 직접 찾은 후보를 모은다. 폐기 자료 수를 셀 때도 같은 경로를 쓰도록 조건과 상한을 인자로 받는다. */
function findDirect(state: SearchState, predicate: SqlPredicate, excluded: Set<string>, candidateLimit: number): { hits: Map<string, DirectHit>; candidateCount: number; total: number } {
  const { db, request, ranking } = state;
  const hits = new Map<string, DirectHit>();
  const hitFor = (item: ScopedItem): DirectHit => {
    let hit = hits.get(item.id);
    if (!hit) {
      hit = { item, reasons: [], terms: [], explicitKey: false, pathOverlap: false, keyHit: false, titleHit: false, coverage: 0, position: null };
      hits.set(item.id, hit);
    }
    return hit;
  };

  if (request.query !== null && request.terms.length > 0) {
    const candidates = keyCandidates(request.query);
    const keyed = selectItems(db, predicate, { sql: "(i.key IS NOT NULL OR i.aliases_json <> '[]')", params: [] }).filter((item) => [item.key, ...item.aliases].some((value) => value !== null && candidates.has(foldKey(value))));
    for (const item of applicableOnly(state, keyed, excluded)) {
      const hit = hitFor(item);
      hit.explicitKey = true;
      hit.reasons.push('explicit-key');
    }
  }

  if (request.paths.size > 0) {
    for (const item of applicableOnly(state, pathMatches(state, predicate), excluded)) {
      const hit = hitFor(item);
      hit.pathOverlap = true;
      hit.reasons.push('path-overlap');
    }
  }

  let candidateCount = 0;
  let total = 0;
  if (request.terms.length > 0) {
    const found = selectItems(db, predicate, { sql: 'i.item_pk IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)', params: [buildMatch(request.terms)] });
    const ranked = applicableOnly(state, found, excluded)
      .map((item) => matchText(item, request.terms, ranking))
      .sort((a, b) => b.coverage - a.coverage || b.weightedHits - a.weightedHits || compareStrings(a.item.id, b.item.id));
    total = ranked.length;
    const candidates = ranked.slice(0, candidateLimit);
    candidateCount = candidates.length;
    candidates.forEach((match, position) => {
      const hit = hitFor(match.item);
      hit.reasons.push('keyword-match');
      hit.terms = match.terms;
      hit.keyHit = match.keyHit;
      hit.titleHit = match.titleHit;
      hit.coverage = match.coverage;
      hit.position = position;
    });
  }
  return { hits, candidateCount, total };
}

function scoreOf(state: SearchState, hit: DirectHit, candidateCount: number): number {
  const { fieldBoosts, statusWeights } = state.ranking;
  const { item } = hit;
  const textScore = hit.position === null ? 0 : 0.6 * hit.coverage + 0.4 * (1 - hit.position / Math.max(candidateCount, 1));
  const boosts = (hit.keyHit ? fieldBoosts.keyOrAlias : 0) + (hit.titleHit ? fieldBoosts.title : 0) + (hit.pathOverlap ? fieldBoosts.pathOverlap : 0) + (hit.explicitKey ? fieldBoosts.explicitKey : 0);
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

export function search(context: RetrievalContext, raw: unknown): SearchResponse {
  const request = parseRequest(raw, context.retrieval);
  const profile = context.retrieval.profiles[request.profile];
  const ranking = context.retrieval.ranking;

  return withGeneration(context, request.scope, request.version, (db, selected) => {
    const scope: EffectiveScope = { ...request.scope, generation: selected.generation, kinds: request.kinds, statuses: request.statuses ?? DEFAULT_STATUSES, statusesExplicit: request.statuses !== null };
    const state: SearchState = { db, scope, request, profile, ranking, applicabilityExcluded: new Set() };
    const sectionByKind = new Map(profile.sections.flatMap((section) => section.kinds.map((kind) => [kind, section.id] as const)));
    const sectionOf = (item: ScopedItem): string => sectionByKind.get(item.kind)!;
    const direct = (section: string, reason: string) => (item: ScopedItem): PickedItem => ({ item, section, score: 0, reasons: [reason], terms: [] });

    const mandatory = findMandatory(state);
    const dependencies = findDependencies(state, mandatory.kept);
    const shown = new Set([...mandatory.kept, ...dependencies.kept].map((item) => item.id));

    const { hits, candidateCount, total } = findDirect(state, sharedPredicate(scope), state.applicabilityExcluded, ranking.candidateLimit);
    const ranked = [...hits.values()]
      .filter((hit) => !shown.has(hit.item.id))
      .map((hit) => ({ hit, score: scoreOf(state, hit, candidateCount) }))
      .sort((a, b) => b.score - a.score || compareStrings(a.hit.item.id, b.hit.item.id))
      .slice(0, request.limit)
      .map(({ hit, score }): PickedItem => ({ item: hit.item, section: sectionOf(hit.item), score, reasons: hit.reasons, terms: hit.terms }));

    const mandatoryPicks = mandatory.kept.map(direct('mandatory', 'mandatory'));
    const dependencyPicks = dependencies.kept.map(direct('dependencies', 'explicit-dependency'));
    const seeds = [...mandatoryPicks, ...dependencyPicks, ...ranked].map((pick) => pick.item);
    const { linked, omitted: linksOmitted } = expandLinks(state, seeds, sectionOf);

    const deprecatedExcluded = scope.statuses.includes('deprecated') ? 0 : findDirect(state, sharedPredicate(scope, ['deprecated']), new Set(), Number.MAX_SAFE_INTEGER).hits.size;
    const findings: SearchFindings = {
      mandatoryOmitted: mandatory.omitted,
      mandatoryFiltered: mandatory.filtered,
      dependenciesOmitted: dependencies.omitted,
      linksOmitted,
      candidatesTruncated: total > candidateCount ? { total, limit: ranking.candidateLimit } : null,
      deprecatedExcluded,
      applicabilityExcluded: state.applicabilityExcluded.size,
    };

    const taskPathList = [...request.paths].flatMap(([project, paths]) => paths.map((path) => (scope.projects.length > 1 ? `${project}:${path}` : path))).sort(compareStrings);
    return composeSearch({
      context,
      request: { profile: request.profile, query: request.query, task: { phase: request.phase, paths: taskPathList }, limit: request.limit },
      scope,
      selected,
      profile,
      inScope: selectItemIds(db, inEffectiveScope(scope)),
      evaluated: (item) => ({ phase: request.phase !== null && isPrimary(state, item), paths: isPrimary(state, item) && request.paths.has(item.projectId) }),
      mandatory: mandatoryPicks,
      dependencies: dependencyPicks,
      direct: ranked,
      linked,
      findings,
    });
  });
}
