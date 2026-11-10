import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeError } from './errors.js';
import { runIndex, type IndexResult, type RunIndexOptions } from './indexing/indexer.js';
import { acquireLease, listLeases, releaseLease, renewLease, type AcquireLeaseOptions, type Lease, type LeaseView } from './indexing/leases.js';
import { SCHEMA_VERSION } from './indexing/schema.js';
import { openExistingForWrite, openForRead, openForWrite, type Store } from './indexing/store.js';
import { loadRetrievalConfig, type RetrievalConfig } from './profiles/config.js';
import { capabilitiesOf, type CapabilitiesResponse } from './retrieval/capabilities.js';
import { getItem, getItemV2 } from './retrieval/get.js';
import { search, searchV2 } from './retrieval/searcher.js';
import type { GetRequest, GetRequestV2, GetResponse, GetResponseV2, RetrievalContext, SearchRequest, SearchRequestV2, SearchResponse, SearchResponseV2 } from './retrieval/types.js';
import { verifyReferences, type VerifyResponse } from './retrieval/verify.js';
import { loadSourcesConfig, type SourcesConfig } from './sources/config.js';

export { checkEmbeddingCompatibility, type CompatibilityMismatch, type CompatibilityResult, type IndexedSpace } from './adapters/compatibility.js';
export type { EmbeddingDescriptor, EmbeddingProvider, VectorDistance } from './adapters/embedding.js';
export { vectorPointId, type VectorFilter, type VectorHit, type VectorPoint, type VectorQuery, type VectorSpaceInfo, type VectorSpaceSpec, type VectorStore } from './adapters/vector-store.js';
export { EXIT_CODES, KnowledgeError, type ErrorCode } from './errors.js';
export { guardStore, openExistingForWrite, openForRead, openForWrite, Store } from './indexing/store.js';
export { runIndex, sourceConfigHash, type IndexHooks, type IndexResult, type ProgressEvent, type RunIndexOptions, type SourceIndexResult } from './indexing/indexer.js';
export { acquireLease, LEASE_TTL_SECONDS, listLeases, MAX_LIVE_LEASES, releaseLease, renewLease, type AcquireLeaseOptions, type Clock, type Lease, type LeaseView } from './indexing/leases.js';
export { MIN_READABLE_SCHEMA, SCHEMA_VERSION } from './indexing/schema.js';
export { BASE_STATUSES, EFFECTIVE_STATUSES, HTTP_METHODS, KINDS, PHASES, type BaseStatus, type EffectiveStatus, type HttpOperation, type Kind, type Phase, type StatusDeclaration } from './model.js';
export { configHashOf, loadRetrievalConfig, type Bm25Config, type ProfileConfig, type QueryLimits, type RankingConfig, type RetrievalConfig } from './profiles/config.js';
export { capabilitiesOf, RESPONSE_VERSIONS, type CapabilitiesResponse } from './retrieval/capabilities.js';
export { getAny, getItem, getItemV2 } from './retrieval/get.js';
export { QUERY_VERSION, RANKER_VERSIONS, search, searchAny, searchV2 } from './retrieval/searcher.js';
export { MAX_REFERENCES, verifyReferences, type KnowledgeState, type VerifyResponse, type VerifyResult } from './retrieval/verify.js';
export type {
  AppliedScope,
  BudgetReport,
  CodeLocation,
  GetRequest,
  GetRequestV2,
  GetResponse,
  GetResponseV2,
  IndexInfo,
  IndexInfoV2,
  ItemRef,
  Limitation,
  OutputConflict,
  OutputItem,
  OutputItemV2,
  OutputLink,
  OutputSegment,
  ProfileName,
  ResultGroup,
  RetrievalContext,
  ScopeRequest,
  SearchCounts,
  SearchRequest,
  SearchRequestV2,
  SearchResponse,
  SearchResponseV2,
  VersionRequest,
  VersionRequestV2,
} from './retrieval/types.js';
export { loadSourcesConfig, type SourceConfig, type SourcesConfig } from './sources/config.js';

const PACKAGED_RETRIEVAL_CONFIG = fileURLToPath(new URL('../../config/retrieval.yaml', import.meta.url));

export interface KnowledgeBaseOptions {
  /** dbPath를 주면 생략할 수 있다. 그때 등록 목록은 세대의 프로젝트뿐이고 색인은 실행할 수 없다. */
  configPath?: string;
  /** 생략하면 패키지에 포함된 config/retrieval.yaml을 쓴다. */
  retrievalConfigPath?: string;
  /** 생략하면 원본 설정의 database.path를 쓴다. */
  dbPath?: string;
}

export interface KnowledgeLeases {
  /** generation을 생략하면 같은 트랜잭션에서 읽은 활성 세대에 건다. */
  acquire(options: Omit<AcquireLeaseOptions, 'clock'>): Lease;
  renew(leaseId: string, ttlSeconds?: number): Lease;
  release(leaseId: string): { released: boolean };
  list(holder?: string): LeaseView[];
}

export interface KnowledgeBase extends RetrievalContext {
  /** 기존 형식(응답 형식 1). 형식 2 요청은 거절하므로 searchV2를 쓴다. */
  search(request: SearchRequest): SearchResponse;
  searchV2(request: SearchRequestV2): SearchResponseV2;
  getItem(request: GetRequest): GetResponse;
  getItemV2(request: GetRequestV2): GetResponseV2;
  /** 넘겨받은 참조의 무결성과 현재 상태를 돌려준다. 승인이나 검증 결과가 아니다. */
  verify(request: unknown): VerifyResponse;
  capabilities(): CapabilitiesResponse;
  leases: KnowledgeLeases;
  runIndex(options?: Pick<RunIndexOptions, 'refOverrides' | 'hooks' | 'onProgress' | 'activate' | 'lease'>): IndexResult;
}

function loadOptionalSources(options: KnowledgeBaseOptions): SourcesConfig | null {
  if (options.configPath === undefined) {
    if (options.dbPath === undefined) throw new KnowledgeError('config-invalid', '원본 설정 경로 또는 데이터베이스 경로가 필요합니다', { reason: 'not-found' });
    return null;
  }
  try {
    return loadSourcesConfig(options.configPath);
  } catch (error) {
    const reason = error instanceof KnowledgeError ? (error.detail as { reason?: string } | undefined)?.reason : undefined;
    if (options.dbPath !== undefined && reason === 'not-found') return null;
    throw error;
  }
}

/** 두 에이전트가 라이브러리로 쓰는 진입점이다. 연결은 호출마다 열고 닫으므로 닫을 자원을 남기지 않는다. */
export function openKnowledgeBase(options: KnowledgeBaseOptions): KnowledgeBase {
  const sources = loadOptionalSources(options);
  const retrieval: RetrievalConfig = loadRetrievalConfig(options.retrievalConfigPath ?? PACKAGED_RETRIEVAL_CONFIG);
  const dbPath = resolve(options.dbPath ?? sources!.database.path);
  const context: RetrievalContext = { dbPath, sources, retrieval };
  const writing = <T>(fn: (store: Store) => T): T => {
    const store = openExistingForWrite(dbPath);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  return {
    ...context,
    search: (request) => search(context, request),
    searchV2: (request) => searchV2(context, request),
    getItem: (request) => getItem(context, request),
    getItemV2: (request) => getItemV2(context, request),
    verify: (request) => verifyReferences(context, request),
    capabilities: () => capabilitiesOf(retrieval),
    leases: {
      acquire: (leaseOptions) => writing((store) => acquireLease(store, leaseOptions)),
      renew: (leaseId, ttlSeconds) => writing((store) => renewLease(store, leaseId, ttlSeconds)),
      release: (leaseId) => writing((store) => releaseLease(store, leaseId)),
      list: (holder) => {
        const store = openForRead(dbPath);
        try {
          if (store.schemaVersion < SCHEMA_VERSION) throw new KnowledgeError('index-missing', '이 요청에는 새 색인 스키마가 필요합니다. index를 한 번 실행해 주십시오', { reason: 'schema-upgrade-required', version: store.schemaVersion, required: SCHEMA_VERSION });
          const now = new Date();
          return store.read((db) => listLeases(db, holder, now));
        } finally {
          store.close();
        }
      },
    },
    runIndex: (runOptions = {}) => {
      if (sources === null) throw new KnowledgeError('config-invalid', '색인에는 원본 설정이 필요합니다', { reason: 'not-found' });
      const store = openForWrite(dbPath);
      try {
        return runIndex({ ...runOptions, config: sources, store });
      } finally {
        store.close();
      }
    },
  };
}
