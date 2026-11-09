import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkEmbeddingCompatibility, vectorPointId, type EmbeddingDescriptor, type EmbeddingProvider, type IndexedSpace } from '../src/index.js';
import { sha256 } from '../src/util/hash.js';

const descriptor: EmbeddingDescriptor = { provider: 'fake', modelId: 'm', modelVersion: '1', dimensions: 4, distance: 'cosine' };
const indexed: IndexedSpace = { ...descriptor, chunkerVersion: 'chunk-1' };

describe('embedding compatibility', () => {
  it('accepts an identical space', () => {
    assert.deepEqual(checkEmbeddingCompatibility(indexed, descriptor, 'chunk-1'), { compatible: true, mismatches: [] });
  });

  const changes: [keyof IndexedSpace, unknown][] = [
    ['provider', 'other'],
    ['modelId', 'other'],
    ['modelVersion', '2'],
    ['dimensions', 8],
    ['distance', 'dot'],
  ];
  for (const [field, value] of changes) {
    it(`reports a ${field} mismatch`, () => {
      const result = checkEmbeddingCompatibility(indexed, { ...descriptor, [field]: value }, 'chunk-1');
      assert.deepEqual(result, { compatible: false, mismatches: [{ field, indexed: indexed[field], provider: value }] });
    });
  }

  it('reports a chunker version mismatch against the current chunker', () => {
    assert.deepEqual(checkEmbeddingCompatibility(indexed, descriptor, 'chunk-2').mismatches, [{ field: 'chunkerVersion', indexed: 'chunk-1', provider: 'chunk-2' }]);
  });

  for (const dimensions of [0, -1, 1.5, Number.NaN]) {
    it(`rejects equal but unusable dimensions ${dimensions}`, () => {
      const result = checkEmbeddingCompatibility({ ...indexed, dimensions }, { ...descriptor, dimensions }, 'chunk-1');
      assert.equal(result.compatible, false);
      assert.deepEqual(result.mismatches.map((mismatch) => mismatch.field), ['dimensions']);
    });
  }

  it('reports every differing field together', () => {
    const result = checkEmbeddingCompatibility(indexed, { provider: 'x', modelId: 'y', modelVersion: 'z', dimensions: 2, distance: 'euclid' }, 'chunk-9');
    assert.deepEqual(result.mismatches.map((mismatch) => mismatch.field), ['provider', 'modelId', 'modelVersion', 'dimensions', 'distance', 'chunkerVersion']);
  });

  it('lets a provider be swapped behind the interface', async () => {
    const provider: EmbeddingProvider = { descriptor, embed: async (texts) => texts.map(() => new Float32Array(descriptor.dimensions)) };
    const [vector] = await provider.embed(['a']);
    assert.equal(vector!.length, checkEmbeddingCompatibility(indexed, provider.descriptor, 'chunk-1').compatible ? 4 : -1);
  });
});

describe('vectorPointId', () => {
  it('is the documented stable hash', () => {
    assert.equal(vectorPointId('s:p#a', 'abc', 'chunk-1'), sha256('s:p#a\0abc\0chunk-1'));
    assert.equal(vectorPointId('s:p#a', 'abc', 'chunk-1'), vectorPointId('s:p#a', 'abc', 'chunk-1'));
  });

  it('changes with each input', () => {
    const base = vectorPointId('s:p#a', 'abc', 'chunk-1');
    assert.notEqual(vectorPointId('s:p#b', 'abc', 'chunk-1'), base);
    assert.notEqual(vectorPointId('s:p#a', 'abd', 'chunk-1'), base);
    assert.notEqual(vectorPointId('s:p#a', 'abc', 'chunk-2'), base);
  });

  it('keeps field boundaries so concatenations cannot collide', () => {
    assert.notEqual(vectorPointId('ab', 'c', 'v'), vectorPointId('a', 'bc', 'v'));
  });
});
