import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeError } from './errors.js';
import { runIndex, type IndexResult, type RunIndexOptions } from './indexing/indexer.js';
import { openForWrite } from './indexing/store.js';
import { loadRetrievalConfig, type RetrievalConfig } from './profiles/config.js';
import { getItem } from './retrieval/get.js';
import { search } from './retrieval/searcher.js';
import type { GetRequest, GetResponse, RetrievalContext, SearchRequest, SearchResponse } from './retrieval/types.js';
import { loadSourcesConfig, type SourcesConfig } from './sources/config.js';

export { checkEmbeddingCompatibility, type CompatibilityMismatch, type CompatibilityResult, type IndexedSpace } from './adapters/compatibility.js';
export type { EmbeddingDescriptor, EmbeddingProvider, VectorDistance } from './adapters/embedding.js';
export { vectorPointId, type VectorFilter, type VectorHit, type VectorPoint, type VectorQuery, type VectorSpaceInfo, type VectorSpaceSpec, type VectorStore } from './adapters/vector-store.js';
export { EXIT_CODES, KnowledgeError, type ErrorCode } from './errors.js';
export { guardStore, openForRead, openForWrite, Store } from './indexing/store.js';
export { runIndex, type IndexHooks, type IndexResult, type ProgressEvent, type RunIndexOptions, type SourceIndexResult } from './indexing/indexer.js';
export { BASE_STATUSES, EFFECTIVE_STATUSES, KINDS, PHASES, type BaseStatus, type EffectiveStatus, type Kind, type Phase } from './model.js';
export { loadRetrievalConfig, type ProfileConfig, type RankingConfig, type RetrievalConfig } from './profiles/config.js';
export { getItem } from './retrieval/get.js';
export { search } from './retrieval/searcher.js';
export type { AppliedScope, CodeLocation, GetRequest, GetResponse, IndexInfo, Limitation, OutputConflict, OutputItem, OutputLink, ProfileName, RetrievalContext, ScopeRequest, SearchRequest, SearchResponse, VersionRequest } from './retrieval/types.js';
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

export interface KnowledgeBase extends RetrievalContext {
  search(request: SearchRequest): SearchResponse;
  getItem(request: GetRequest): GetResponse;
  runIndex(options?: Pick<RunIndexOptions, 'refOverrides' | 'hooks' | 'onProgress'>): IndexResult;
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
  return {
    ...context,
    search: (request) => search(context, request),
    getItem: (request) => getItem(context, request),
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
