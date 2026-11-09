import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { KnowledgeError } from '../errors.js';
import type { BasisRecord, Conflict, LinkRecord } from '../indexing/resolve.js';
import { openForRead, type Store } from '../indexing/store.js';
import { DEFAULT_LINK_KINDS, KINDS, type AppliesTo, type BaseStatus, type EffectiveStatus, type Kind, type Unit } from '../model.js';
import type { ProfileConfig } from '../profiles/config.js';
import type { SkippedPath } from '../sources/collect.js';
import { compareStrings, sortedUnique } from '../util/compare.js';
import type { RetrievalContext, VersionRequest } from './types.js';

/** z.record는 __proto__ 키를 조용히 버린다. 그대로 두면 커밋 조건 없이 활성 세대를 돌려주므로 다른 모르는 원본처럼 거부한다. */
function rejectPrototypeCommitKey(raw: unknown): unknown {
  const commits = (raw as { commits?: unknown } | null | undefined)?.commits;
  if (typeof commits === 'object' && commits !== null && Object.hasOwn(commits, '__proto__')) throw invalidScope('등록되지 않은 원본입니다: __proto__', { reason: 'unknown-source', sourceId: '__proto__' });
  return raw;
}

export const versionSchema = z.preprocess(
  rejectPrototypeCommitKey,
  z.strictObject({
    generation: z.number().int().positive().optional(),
    commits: z.record(z.string().min(1), z.string().regex(/^[0-9a-fA-F]{7,64}$/)).optional(),
  }),
);

const scopeSchema = z.strictObject({
  projects: z.array(z.string().min(1)).min(1),
  allowedLinks: z
    .array(z.strictObject({ project: z.string().min(1), kinds: z.array(z.enum(KINDS)).min(1).optional(), itemIds: z.array(z.string().min(1)).min(1).optional() }))
    .optional(),
});

interface ScopeLink {
  project: string;
  kinds: Kind[];
  itemIds: string[] | null;
}

export interface RequestedScope {
  projects: string[];
  links: ScopeLink[];
}

export interface EffectiveScope extends RequestedScope {
  generation: number;
  kinds: Kind[] | null;
  statuses: EffectiveStatus[];
  statusesExplicit: boolean;
}

type SqlParam = string | number;

export interface SqlPredicate {
  sql: string;
  params: SqlParam[];
}

interface GenerationSource {
  sourceId: string;
  projectId: string;
  commit: string;
  requestedRef: string;
  skipped: SkippedPath[];
}

export interface SelectedGeneration {
  generation: number;
  publishedAt: string;
  parserVersion: string;
  chunkerVersion: string;
  tokenizerVersion: string;
  resolverVersion: string;
  sources: GenerationSource[];
}

export interface ScopedItem {
  id: string;
  key: string | null;
  anchor: string;
  unit: Unit;
  kind: Kind;
  title: string;
  headingPath: string[];
  content: string;
  itemSha256: string;
  startLine: number;
  endLine: number;
  ordinal: number;
  declaredStatus: BaseStatus | null;
  aliases: string[];
  appliesTo: AppliesTo;
  baseStatus: BaseStatus;
  effectiveStatus: EffectiveStatus;
  statusReason: string;
  basis: BasisRecord;
  conflicts: Conflict[];
  links: LinkRecord[];
  sourceId: string;
  projectId: string;
  path: string;
  blobSha: string;
  documentSha256: string;
  firstGeneration: number;
}

type ItemRow = Omit<ScopedItem, 'headingPath' | 'aliases' | 'appliesTo' | 'basis' | 'conflicts' | 'links'> & { headingPath: string; aliases: string; appliesTo: string; basis: string; conflicts: string; links: string };

const ITEM_SOURCE = 'generation_items g JOIN items i ON i.item_pk = g.item_pk JOIN documents d ON d.document_pk = i.document_pk';
const ITEM_COLUMNS = `
  i.item_id AS id, i.key AS key, i.anchor AS anchor, i.unit AS unit, i.kind AS kind, i.title AS title, i.heading_path_json AS headingPath,
  i.content AS content, i.content_sha256 AS itemSha256, i.start_line AS startLine, i.end_line AS endLine, i.ordinal AS ordinal,
  i.declared_status AS declaredStatus, i.aliases_json AS aliases, i.applies_to_json AS appliesTo,
  g.base_status AS baseStatus, g.effective_status AS effectiveStatus, g.status_reason AS statusReason, g.basis_json AS basis, g.conflicts_json AS conflicts, g.links_json AS links,
  d.source_id AS sourceId, d.project_id AS projectId, d.path AS path, d.blob_sha AS blobSha, d.content_sha256 AS documentSha256, d.first_generation AS firstGeneration`;

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function invalidScope(message: string, detail: Record<string, unknown>): KnowledgeError {
  return new KnowledgeError('invalid-scope', message, detail);
}

export function parseScope(raw: unknown, profile: ProfileConfig): RequestedScope {
  const parsed = scopeSchema.safeParse(raw);
  if (!parsed.success) throw invalidScope('검색 범위의 형식이 올바르지 않습니다', { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });

  const { projects, allowedLinks = [] } = parsed.data;
  if (new Set(projects).size !== projects.length) throw invalidScope('검색 범위에 프로젝트가 중복되었습니다', { reason: 'duplicate-project' });
  if (profile.requiresSingleProject && projects.length !== 1) throw invalidScope('이 프로필은 프로젝트를 정확히 하나만 받습니다', { reason: 'single-project-required', count: projects.length });

  const seen = new Set<string>();
  const links = allowedLinks.map((link): ScopeLink => {
    if (seen.has(link.project) || projects.includes(link.project)) throw invalidScope('허용 연결의 프로젝트가 중복되었습니다', { reason: 'duplicate-link-project', project: link.project });
    seen.add(link.project);
    const ceiling = profile.allowedLinkKinds;
    if (ceiling !== '*' && link.kinds?.some((kind) => !ceiling.includes(kind))) throw invalidScope('이 프로필이 허용하지 않는 자료 종류입니다', { reason: 'link-kind-not-allowed', project: link.project });
    return { project: link.project, kinds: sortedUnique(link.kinds ?? DEFAULT_LINK_KINDS), itemIds: link.itemIds ? sortedUnique(link.itemIds) : null };
  });
  return { projects: sortedUnique(projects), links: links.sort((a, b) => compareStrings(a.project, b.project)) };
}

/** 유효 범위의 유일한 정의다. 항목을 읽는 모든 경로가 이 조건을 거치므로 범위 규칙은 여기서만 고친다. */
export function inEffectiveScope(scope: EffectiveScope): SqlPredicate {
  const arms = [`d.project_id IN (${placeholders(scope.projects)})`];
  const params: SqlParam[] = [scope.generation, ...scope.projects];
  for (const link of scope.links) {
    const itemIds = link.itemIds ? ` AND i.item_id IN (${placeholders(link.itemIds)})` : '';
    arms.push(`(d.project_id = ? AND i.kind IN (${placeholders(link.kinds)})${itemIds})`);
    params.push(link.project, ...link.kinds, ...(link.itemIds ?? []));
  }
  return { sql: `g.generation = ? AND (${arms.join(' OR ')})`, params };
}

/** statuses가 null이면 상태 조건을 걸지 않는다. 필수 자료 조회는 기본 상태 제외 대신 자체 기준을 쓴다. */
export function sharedPredicate(scope: EffectiveScope, statuses: readonly EffectiveStatus[] | null = scope.statuses): SqlPredicate {
  const scoped = inEffectiveScope(scope);
  const clauses = [scoped.sql];
  const params = [...scoped.params];
  if (scope.kinds) {
    clauses.push(`i.kind IN (${placeholders(scope.kinds)})`);
    params.push(...scope.kinds);
  }
  if (statuses) {
    clauses.push(`g.effective_status IN (${placeholders(statuses)})`);
    params.push(...statuses);
  }
  return { sql: clauses.join(' AND '), params };
}

export function primaryProjects(scope: EffectiveScope): SqlPredicate {
  return { sql: `d.project_id IN (${placeholders(scope.projects)})`, params: [...scope.projects] };
}

function all<T>(db: DatabaseSync, sql: string, params: readonly SqlParam[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function selectItems(db: DatabaseSync, predicate: SqlPredicate, condition: SqlPredicate): ScopedItem[] {
  return all<ItemRow>(db, `SELECT ${ITEM_COLUMNS} FROM ${ITEM_SOURCE} WHERE ${predicate.sql} AND ${condition.sql}`, [...predicate.params, ...condition.params]).map((row) => ({
    ...row,
    headingPath: JSON.parse(row.headingPath) as string[],
    aliases: JSON.parse(row.aliases) as string[],
    appliesTo: JSON.parse(row.appliesTo) as AppliesTo,
    basis: JSON.parse(row.basis) as BasisRecord,
    conflicts: JSON.parse(row.conflicts) as Conflict[],
    links: JSON.parse(row.links) as LinkRecord[],
  }));
}

export function selectItemIds(db: DatabaseSync, predicate: SqlPredicate): Set<string> {
  return new Set(all<{ id: string }>(db, `SELECT i.item_id AS id FROM ${ITEM_SOURCE} WHERE ${predicate.sql}`, predicate.params).map((row) => row.id));
}

function requestedProjects(scope: RequestedScope): string[] {
  return [...scope.projects, ...scope.links.map((link) => link.project)];
}

/** 색인을 볼 수 없으면 설정만으로 범위를 판단하고, 알 수 없는 프로젝트를 색인 문제로 보고하지 않는다. */
function scopeErrorOr(context: RetrievalContext, projects: readonly string[], error: unknown): unknown {
  if (!(error instanceof KnowledgeError) || (error.code !== 'index-missing' && error.code !== 'store-unavailable')) return error;
  const configured = context.sources?.sources.map((source) => source.project);
  const unknown = configured ? projects.find((project) => !configured.includes(project)) : undefined;
  return unknown === undefined ? error : invalidScope(`등록되지 않은 프로젝트입니다: ${unknown}`, { reason: 'unknown-project', project: unknown });
}

/**
 * 커밋 선택보다 먼저 검사한다. 뒤로 미루면 모르는 원본이 commit-not-indexed로 보고되고,
 * 범위 밖 원본의 커밋 존재 여부를 응답 차이로 알아낼 수 있다.
 */
function assertCommitKeys(db: DatabaseSync, context: RetrievalContext, projects: readonly string[], commits: Record<string, string>): void {
  const owners = new Map<string, Set<string>>();
  const add = (sourceId: string, projectId: string): void => {
    owners.set(sourceId, (owners.get(sourceId) ?? new Set()).add(projectId));
  };
  for (const source of context.sources?.sources ?? []) add(source.id, source.project);
  for (const row of all<{ sourceId: string; projectId: string }>(db, 'SELECT DISTINCT source_id AS sourceId, project_id AS projectId FROM generation_sources')) add(row.sourceId, row.projectId);
  for (const sourceId of Object.keys(commits).sort(compareStrings)) {
    const projectIds = owners.get(sourceId);
    if (!projectIds) throw invalidScope(`등록되지 않은 원본입니다: ${sourceId}`, { reason: 'unknown-source', sourceId });
    if (![...projectIds].some((project) => projects.includes(project))) throw invalidScope(`검색 범위 밖의 원본입니다: ${sourceId}`, { reason: 'source-out-of-scope', sourceId });
  }
}

function sourcesOf(db: DatabaseSync, generation: number): GenerationSource[] {
  return all<Omit<GenerationSource, 'skipped'> & { skipped: string }>(db, 'SELECT source_id AS sourceId, project_id AS projectId, commit_sha AS "commit", requested_ref AS requestedRef, skipped_json AS skipped FROM generation_sources WHERE generation = ? ORDER BY source_id', [generation]).map((row) => ({
    ...row,
    skipped: JSON.parse(row.skipped) as SkippedPath[],
  }));
}

function indexMissing(reason: string, message: string, detail: Record<string, unknown> = {}): KnowledgeError {
  return new KnowledgeError('index-missing', message, { reason, ...detail });
}

function selectGeneration(db: DatabaseSync, active: number, version: VersionRequest): SelectedGeneration {
  const commits = Object.entries(version.commits ?? {});
  const ceiling = version.generation ?? Number.MAX_SAFE_INTEGER;
  const retained = all<{ generation: number }>(db, 'SELECT generation FROM generations ORDER BY generation DESC').map((row) => row.generation);
  if (version.generation !== undefined && !retained.includes(version.generation)) throw indexMissing('generation-not-found', `색인 세대를 찾을 수 없습니다: ${version.generation}`, { generation: version.generation });

  let generation = version.generation ?? active;
  if (commits.length > 0) {
    const match = retained.filter((candidate) => candidate <= ceiling).find((candidate) => {
      const sources = sourcesOf(db, candidate);
      return commits.every(([sourceId, sha]) => sources.find((source) => source.sourceId === sourceId)?.commit.startsWith(sha.toLowerCase()));
    });
    if (match === undefined) throw indexMissing('commit-not-indexed', '요청한 커밋을 포함한 색인 세대가 없습니다', { commits: Object.fromEntries(commits) });
    generation = match;
  }

  const row = all<Omit<SelectedGeneration, 'generation' | 'sources'>>(db, 'SELECT published_at AS publishedAt, parser_version AS parserVersion, chunker_version AS chunkerVersion, tokenizer_version AS tokenizerVersion, resolver_version AS resolverVersion FROM generations WHERE generation = ?', [generation])[0]!;
  return { generation, ...row, sources: sourcesOf(db, generation) };
}

function assertProjectsIndexed(context: RetrievalContext, projects: readonly string[], selected: SelectedGeneration): void {
  const indexed = new Set(selected.sources.map((source) => source.projectId));
  const configured = new Set(context.sources?.sources.map((source) => source.project));
  for (const project of projects) {
    if (!indexed.has(project) && !configured.has(project)) throw invalidScope(`등록되지 않은 프로젝트입니다: ${project}`, { reason: 'unknown-project', project });
  }
  for (const project of projects) {
    if (!indexed.has(project)) throw indexMissing('project-not-indexed', `프로젝트가 이 색인 세대에 없습니다: ${project}`, { project, generation: selected.generation });
  }
}

/** 저장소 열기, 커밋 키, 세대 선택, 프로젝트 등록을 차례로 검증한 뒤 한 읽기 트랜잭션 안에서 fn을 실행한다. */
export function withGeneration<T>(context: RetrievalContext, scope: RequestedScope, version: VersionRequest, fn: (db: DatabaseSync, selected: SelectedGeneration) => T): T {
  const projects = requestedProjects(scope);
  let store: Store;
  try {
    store = openForRead(context.dbPath);
  } catch (error) {
    throw scopeErrorOr(context, projects, error);
  }
  try {
    return store.read((db) => {
      const active = all<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'active_generation'")[0];
      if (active === undefined) throw scopeErrorOr(context, projects, indexMissing('no-generation', '게시된 색인이 없습니다'));
      if (version.commits) assertCommitKeys(db, context, projects, version.commits);
      const selected = selectGeneration(db, Number(active.value), version);
      assertProjectsIndexed(context, projects, selected);
      return fn(db, selected);
    });
  } finally {
    store.close();
  }
}
