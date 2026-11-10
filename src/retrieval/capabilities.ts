import { LEASE_TTL_SECONDS, MAX_LIVE_LEASES } from '../indexing/leases.js';
import { MIN_READABLE_SCHEMA, SCHEMA_VERSION } from '../indexing/schema.js';
import { SEGMENT_MAX_CHARS } from '../parsing/segments.js';
import { CHUNKER_VERSION, PARSER_VERSION, RESOLVER_VERSION, TOKENIZER_VERSION } from '../parsing/versions.js';
import { bm25Of, configHashOf, queryLimitsOf, type Bm25Config, type QueryLimits, type RetrievalConfig } from '../profiles/config.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../util/package-info.js';
import { NOTICE } from './compose.js';
import { QUERY_VERSION, RANKER_VERSIONS } from './searcher.js';
import { RESULT_GROUPS, type ResultGroup } from './types.js';
import { MAX_REFERENCES } from './verify.js';

/** 명령마다 받을 수 있는 응답 형식. 생략하면 1이다. 새 명령은 1부터 시작한다. */
export const RESPONSE_VERSIONS = {
  validate: [1],
  index: [1, 2],
  status: [1, 2],
  search: [1, 2],
  get: [1, 2],
  eval: [1, 2],
  capabilities: [1],
  verify: [1],
  lease: [1],
} as const satisfies Record<string, readonly number[]>;

export interface CapabilitiesResponse {
  schema: 'agent-knowledge.capabilities';
  schemaVersion: 1;
  ok: true;
  status: 'ok';
  notice: string;
  package: { name: string; version: string };
  commands: { [command in keyof typeof RESPONSE_VERSIONS]: { responseVersions: readonly number[]; defaultResponseVersion: 1 } };
  index: { schemaVersion: number; minReadableSchemaVersion: number; v2RequiresSchemaVersion: number };
  versions: { parser: string; chunker: string; tokenizer: string; resolver: string; query: string };
  rankers: { name: 'legacy' | 'bm25'; version: string; default: boolean; parameters: Bm25Config | null }[];
  segments: { chunkerVersion: string; maxChars: number; defaultEnabled: false };
  queryLimits: QueryLimits;
  budget: { groups: readonly ResultGroup[]; fields: readonly string[] };
  leases: { ttlSeconds: { default: number; min: number; max: number }; maxLive: number };
  verify: { maxReferences: number };
  profiles: { master: { configHash: string }; code: { configHash: string } };
  vector: { implemented: false; state: 'not-implemented' };
}

/** 색인 DB 없이 이 빌드와 검색 설정이 지원하는 것을 알린다. 소비자는 이 값으로 기능을 협의하고 요청 형식을 고른다. */
export function capabilitiesOf(retrieval: RetrievalConfig): CapabilitiesResponse {
  const commands = Object.fromEntries(Object.entries(RESPONSE_VERSIONS).map(([name, versions]) => [name, { responseVersions: versions, defaultResponseVersion: 1 as const }])) as unknown as CapabilitiesResponse['commands'];
  return {
    schema: 'agent-knowledge.capabilities',
    schemaVersion: 1,
    ok: true,
    status: 'ok',
    notice: NOTICE,
    package: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    commands,
    index: { schemaVersion: SCHEMA_VERSION, minReadableSchemaVersion: MIN_READABLE_SCHEMA, v2RequiresSchemaVersion: SCHEMA_VERSION },
    versions: { parser: PARSER_VERSION, chunker: CHUNKER_VERSION, tokenizer: TOKENIZER_VERSION, resolver: RESOLVER_VERSION, query: QUERY_VERSION },
    rankers: [
      { name: 'legacy', version: RANKER_VERSIONS.legacy, default: true, parameters: null },
      { name: 'bm25', version: RANKER_VERSIONS.bm25, default: false, parameters: bm25Of(retrieval.ranking) },
    ],
    segments: { chunkerVersion: CHUNKER_VERSION, maxChars: SEGMENT_MAX_CHARS, defaultEnabled: false },
    queryLimits: queryLimitsOf(retrieval),
    budget: { groups: RESULT_GROUPS, fields: ['maxItems', 'maxExcerptChars', 'maxResponseBytes', 'priority'] },
    leases: { ttlSeconds: { ...LEASE_TTL_SECONDS }, maxLive: MAX_LIVE_LEASES },
    verify: { maxReferences: MAX_REFERENCES },
    profiles: { master: { configHash: configHashOf(retrieval, 'master') }, code: { configHash: configHashOf(retrieval, 'code') } },
    vector: { implemented: false, state: 'not-implemented' },
  };
}
