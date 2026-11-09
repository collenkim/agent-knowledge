import type { Conflict, BasisRecord } from '../indexing/resolve.js';
import type { BaseStatus, EffectiveStatus, Kind, Phase, Unit } from '../model.js';
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
