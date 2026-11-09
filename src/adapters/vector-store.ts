import type { Kind } from '../model.js';
import { sha256 } from '../util/hash.js';
import type { IndexedSpace } from './compatibility.js';

// Qdrant 구현은 후속 단계다.

export type VectorSpaceSpec = IndexedSpace;

export interface VectorPoint {
  id: string;
  vector: Float32Array;
  itemId: string;
  projectId: string;
  kind: Kind;
}

/** 세대 소속은 벡터 저장소가 모르므로 SQLite에서 호출 전후로 판단한다. */
export interface VectorFilter {
  allowedPointIds?: string[];
  projects?: string[];
  kinds?: Kind[];
}

export interface VectorQuery {
  vector: Float32Array;
  limit: number;
  filter: VectorFilter;
}

export interface VectorHit {
  pointId: string;
  score: number;
}

export interface VectorSpaceInfo extends VectorSpaceSpec {
  pointCount: number;
}

export interface VectorStore {
  ensureSpace(spec: VectorSpaceSpec): Promise<void>;
  upsert(points: readonly VectorPoint[]): Promise<void>;
  delete(pointIds: readonly string[]): Promise<void>;
  search(query: VectorQuery): Promise<VectorHit[]>;
  describe(): Promise<VectorSpaceInfo | null>;
}

export function vectorPointId(itemId: string, itemSha256: string, chunkerVersion: string): string {
  return sha256(`${itemId}\0${itemSha256}\0${chunkerVersion}`);
}
