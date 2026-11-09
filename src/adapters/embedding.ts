export type VectorDistance = 'cosine' | 'dot' | 'euclid';

export interface EmbeddingDescriptor {
  provider: string;
  modelId: string;
  modelVersion: string;
  dimensions: number;
  distance: VectorDistance;
}

/** 이번 버전에는 구현체가 없다. 실제 모델 연결은 후속 단계다. */
export interface EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}
