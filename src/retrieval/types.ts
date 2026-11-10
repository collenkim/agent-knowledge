import type { Conflict, BasisRecord } from '../indexing/resolve.js';
import type { BaseStatus, EffectiveStatus, HttpOperation, Kind, Phase, StatusDeclaration, Unit } from '../model.js';
import type { RetrievalConfig } from '../profiles/config.js';
import type { SourcesConfig } from '../sources/config.js';

export type ProfileName = 'master' | 'code';

export interface ScopeRequest {
  projects: string[];
  allowedLinks?: { project: string; kinds?: Kind[]; itemIds?: string[] }[];
}

export interface VersionRequest {
  generation?: number;
  /** 원본 ID → 커밋 SHA 또는 7자 이상의 접두사 */
  commits?: Record<string, string>;
}

export interface SearchRequest {
  /** 생략하거나 1이면 기존 형식이다. */
  responseVersion?: 1;
  profile: ProfileName;
  query?: string;
  scope: ScopeRequest;
  filters?: { kinds?: Kind[]; statuses?: EffectiveStatus[] };
  version?: VersionRequest;
  task?: { phase?: Phase; paths?: string[] };
  limit?: number;
}

export interface GetRequest {
  id: string;
  profile: ProfileName;
  scope: ScopeRequest;
  version?: VersionRequest;
}

export interface RetrievalContext {
  dbPath: string;
  /** --db만 주고 설정 파일이 없으면 null이다. 이때 등록 목록은 세대의 프로젝트뿐이다. */
  sources: SourcesConfig | null;
  retrieval: RetrievalConfig;
}

export interface Limitation {
  code: string;
  message: string;
  detail: Record<string, unknown>;
}

export interface OutputLink {
  relation: string;
  target: string;
  resolved: boolean;
  ambiguous?: boolean;
  targetItemId?: string;
  targetProject?: string;
  included: boolean;
  inScope: boolean;
}

export interface OutputConflict extends Omit<Conflict, 'withItemIds'> {
  withItemIds: string[];
  outOfScopeCount: number;
}

export interface OutputItem {
  id: string;
  key: string | null;
  projectId: string;
  sourceId: string;
  kind: Kind;
  unit: Unit;
  title: string;
  headingPath: string[];
  excerpt: string;
  excerptTruncated: boolean;
  provenance: {
    path: string;
    startLine: number;
    endLine: number;
    excerptStartLine: number;
    excerptEndLine: number;
    anchor: string;
    commit: string;
    blobSha: string;
    documentSha256: string;
    itemSha256: string;
    parserVersion: string;
    chunkerVersion: string;
    generation: number;
    firstGeneration: number;
  };
  knowledge: {
    status: EffectiveStatus;
    statusLabel: string;
    baseStatus: BaseStatus;
    declaredStatus: BaseStatus | null;
    confirmed: boolean;
    reason: string;
    basis: BasisRecord & { outOfScopeCount?: number };
    conflicts: OutputConflict[];
  };
  applicability: {
    global: boolean;
    paths: string[];
    phases: Phase[];
    conditions: string | null;
    evaluated: { phase: boolean; paths: boolean; conditions: boolean };
  };
  selection: { section: string; rank: number; score: number; reasons: string[]; matchedTerms: string[] };
  links: OutputLink[];
}

export interface AppliedScope {
  projects: string[];
  allowedLinks: { project: string; kinds: Kind[]; itemIds: string[] | null }[];
  kinds: Kind[] | null;
  statuses: EffectiveStatus[];
}

export interface IndexInfo {
  generation: number;
  publishedAt: string;
  parserVersion: string;
  chunkerVersion: string;
  tokenizerVersion: string;
  resolverVersion: string;
  sources: { sourceId: string; projectId: string; commit: string; requestedRef: string }[];
}

export interface CodeLocation {
  sourceId: string;
  projectId: string;
  commit: string;
  path: string;
  relation: string;
  resolved: boolean;
  fromItemIds: string[];
}

export interface SearchResponse {
  schema: 'agent-knowledge.search';
  schemaVersion: 1;
  ok: true;
  status: 'ok' | 'no-results';
  notice: string;
  request: { profile: ProfileName; query: string | null; task: { phase: Phase | null; paths: string[] }; limit: number };
  appliedScope: AppliedScope;
  index: IndexInfo;
  retrieval: { mode: 'keyword'; vector: { enabled: false; state: 'not-implemented' }; directCount: number };
  sections: { id: string; title: string; itemIds: string[] }[];
  items: OutputItem[];
  codeLocations: CodeLocation[];
  limitations: Limitation[];
}

export interface GetResponse {
  schema: 'agent-knowledge.get';
  schemaVersion: 1;
  ok: true;
  status: 'ok';
  notice: string;
  appliedScope: AppliedScope;
  index: IndexInfo;
  item: OutputItem & { content: string };
  limitations: Limitation[];
}

/** 응답 형식 2에서 결과가 속한 묶음. 기존 sections와 달리 왜 들어왔는지를 나타낸다. */
export type ResultGroup = 'mandatory' | 'dependencies' | 'direct' | 'linked';
export const RESULT_GROUPS: readonly ResultGroup[] = ['mandatory', 'dependencies', 'direct', 'linked'];

export interface VersionRequestV2 extends VersionRequest {
  /** 이 값과 데이터베이스의 색인 식별자가 다르면 index-missing(index-id-mismatch)이다. */
  indexId?: string;
  /** true면 generation으로 지정한 세대만 쓴다. commits가 그 세대와 다르면 index-missing(commit-not-in-generation)이다. */
  exact?: boolean;
}

export interface SearchRequestV2 extends Omit<SearchRequest, 'version' | 'filters' | 'responseVersion'> {
  responseVersion: 2;
  /** query와 함께 또는 대신 쓰는 여러 질의. 문자열이면 키는 q<위치>다. */
  queries?: (string | { key?: string; text: string })[];
  /** 상한을 넘으면 error(기본)는 요청을 거부하고 truncate는 잘라 쓴 뒤 limitations에 적는다. */
  overflow?: 'error' | 'truncate';
  ranker?: 'legacy' | 'bm25';
  segments?: boolean;
  filters?: { kinds?: Kind[]; statuses?: EffectiveStatus[]; documents?: string[] };
  include?: { mandatory?: boolean; dependencies?: boolean; links?: boolean };
  quota?: { maxPerProject?: number; minPerKind?: Partial<Record<Kind, number>> };
  budget?: { maxItems?: number; maxExcerptChars?: number; maxResponseBytes?: number; priority?: ResultGroup[] };
  version?: VersionRequestV2;
}

/** 소비자 사이에 넘기는 항목 참조. 승인·검증 기록이 아니라 근거의 위치와 해시다. */
export interface ItemRef {
  /** 인용용 짧은 이름. 조회 키가 아니며 나머지 필드에서 다시 계산할 수 있다. */
  handle: string;
  indexId: string | null;
  indexGeneration: number;
  sourceId: string;
  projectId: string;
  commit: string;
  itemId: string;
  itemSha256: string;
  documentSha256: string;
  blobSha: string;
  path: string;
  startLine: number;
  endLine: number;
  segmentId: string | null;
  segmentSha256: string | null;
  segmentStartLine: number | null;
  segmentEndLine: number | null;
}

export interface OutputSegment {
  id: string;
  ordinal: number;
  count: number;
  startLine: number;
  endLine: number;
  sha256: string;
  /** 조각이 ATX 제목으로 시작하면 그 제목이다. */
  heading: string | null;
}

export interface OutputItemV2 extends Omit<OutputItem, 'knowledge' | 'selection'> {
  knowledge: OutputItem['knowledge'] & { declaration: StatusDeclaration | null };
  selection: OutputItem['selection'] & { directRank: number | null; matchedQueries: string[] };
  /** get으로 직접 조회한 항목은 lookup이다. */
  group: ResultGroup | 'lookup';
  mandatory: boolean;
  segment: OutputSegment | null;
  /** null이면 이 항목을 색인한 파서가 HTTP 작업을 뽑지 않았다(스키마 2 이전). */
  operations: HttpOperation[] | null;
  ref: ItemRef;
}

export interface IndexInfoV2 extends Omit<IndexInfo, 'sources'> {
  sources: (IndexInfo['sources'][number] & { refOrigin: 'config' | 'override' | null })[];
  indexId: string | null;
  scopeFingerprint: string;
  activated: boolean;
  /** 아직 활성화한 세대가 없으면 null이다(--no-activate로만 게시한 DB). */
  activeGeneration: number | null;
  selection: { by: 'active' | 'generation' | 'commits' | 'generation+commits'; exact: boolean };
}

export interface SearchCounts {
  mandatory: number;
  dependencies: number;
  direct: number;
  linked: number;
  /** limit와 할당량을 적용하기 전 직접 일치 수. */
  directMatched: number;
  /** 질의·경로와 일치했지만 필수·의존 묶음에 이미 있어 직접 결과에서 뺀 항목 수. 이 항목의 selection.matchedQueries에 일치한 질의가 있다. */
  supplementaryMatched: number;
}

export interface CompositionCounts {
  byProject: Record<string, number>;
  byKind: Record<string, number>;
}

export interface BudgetReport {
  limits: { maxItems: number | null; maxExcerptChars: number | null; maxResponseBytes: number | null; priority: ResultGroup[] };
  truncated: boolean;
  /** 아무 항목 없이도 maxResponseBytes를 넘었다. */
  exceeded: boolean;
  omitted: { id: string; segmentId: string | null; group: ResultGroup; directRank: number | null }[];
  omittedCount: number;
}

export interface SearchResponseV2 extends Omit<SearchResponse, 'schemaVersion' | 'request' | 'index' | 'retrieval' | 'items' | 'appliedScope'> {
  schemaVersion: 2;
  request: SearchResponse['request'] & {
    responseVersion: 2;
    queries: { key: string; chars: number; sha256: string; duplicateOf: string | null }[];
    ranker: 'legacy' | 'bm25';
    segments: boolean;
    include: { mandatory: boolean; dependencies: boolean; links: boolean };
    quota: SearchRequestV2['quota'] | null;
    budget: SearchRequestV2['budget'] | null;
    documents: string[] | null;
  };
  appliedScope: AppliedScope & { documents: { project: string; path: string }[] | null };
  index: IndexInfoV2;
  retrieval: SearchResponse['retrieval'] & {
    outcome: 'matched' | 'supplementary-only' | 'no-results';
    ranker: { name: 'legacy' | 'bm25'; version: string };
    queryVersion: string;
    segments: { requested: boolean; effective: boolean; chunkerVersion: string; maxChars: number };
    configHash: string;
    counts: SearchCounts & { kept: Omit<SearchCounts, 'directMatched' | 'supplementaryMatched'> };
    /** 남은 항목의 프로젝트·종류 분포. 치우침을 알리기만 하고 채워 넣지 않는다. 채우려면 quota를 요청한다. */
    composition: { direct: CompositionCounts; supplementary: CompositionCounts };
  };
  items: OutputItemV2[];
  budget: BudgetReport;
  digests: { request: string; items: string; result: string };
}

export interface GetRequestV2 extends Omit<GetRequest, 'version'> {
  responseVersion: 2;
  /** 기대하는 해시. 다르면 not-found 대신 invalid-request(hash-mismatch)로 알린다. */
  expect?: { itemSha256?: string; segmentSha256?: string };
  version?: VersionRequestV2;
}

export interface GetResponseV2 extends Omit<GetResponse, 'schemaVersion' | 'item' | 'index'> {
  schemaVersion: 2;
  index: IndexInfoV2;
  item: OutputItemV2 & { content: string; segmentContent: string | null };
}
