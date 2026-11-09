import type { EmbeddingDescriptor } from './embedding.js';

export interface IndexedSpace extends EmbeddingDescriptor {
  chunkerVersion: string;
}

export interface CompatibilityMismatch {
  field: keyof IndexedSpace;
  indexed: unknown;
  provider: unknown;
}

export interface CompatibilityResult {
  compatible: boolean;
  mismatches: CompatibilityMismatch[];
}

const COMPARED_FIELDS = ['provider', 'modelId', 'modelVersion', 'dimensions', 'distance'] as const;

export function checkEmbeddingCompatibility(indexed: IndexedSpace, descriptor: EmbeddingDescriptor, chunkerVersion: string): CompatibilityResult {
  const mismatches: CompatibilityMismatch[] = COMPARED_FIELDS.filter((field) => indexed[field] !== descriptor[field]).map((field) => ({ field, indexed: indexed[field], provider: descriptor[field] }));
  const validDimensions = Number.isInteger(indexed.dimensions) && indexed.dimensions > 0 && Number.isInteger(descriptor.dimensions) && descriptor.dimensions > 0;
  // 양쪽 값이 같아도 0이나 소수 차원은 쓸 수 없는 공간이다
  if (!validDimensions && indexed.dimensions === descriptor.dimensions) mismatches.push({ field: 'dimensions', indexed: indexed.dimensions, provider: descriptor.dimensions });
  if (indexed.chunkerVersion !== chunkerVersion) mismatches.push({ field: 'chunkerVersion', indexed: indexed.chunkerVersion, provider: chunkerVersion });
  return { compatible: mismatches.length === 0, mismatches };
}
