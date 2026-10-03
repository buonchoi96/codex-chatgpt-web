import { expect, test } from 'bun:test';
import { ChunkTokenEstimator } from '../src/lib/token-estimate';

test('oversized contexts retain their immutable prefix instead of evicting it on every scan', () => {
  let calls = 0;
  const estimator = new ChunkTokenEstimator(text => { calls++; return text.length; });
  const text = Array.from({length: 620}, (_, i) => String(i).padStart(4, '0').repeat(1024)).join('');
  expect(estimator.estimate(text)).toBe(text.length);
  expect(calls).toBe(620);
  expect(estimator.estimate(text + 'changed suffix')).toBe(text.length + 14);
  expect(calls).toBe(620 + 108 + 1);
});

test('unchanged token chunks are counted once while a changed suffix is recounted', () => {
  const chunks: string[] = [];
  const estimator = new ChunkTokenEstimator(text => { chunks.push(text); return text.length; });
  expect(estimator.estimate('a'.repeat(4096)+'x')).toBe(4097);
  expect(estimator.estimate('a'.repeat(4096)+'y')).toBe(4097);
  expect(estimator.estimate('a'.repeat(4096)+'y')).toBe(4097);
  expect(chunks).toEqual(['a'.repeat(4096), 'x', 'y']);
});

test('cached token chunks preserve surrogate pairs and tokenizer scope', () => {
  const chunks: string[] = [];
  const estimator = new ChunkTokenEstimator(text => { chunks.push(text); return Array.from(text).length; });
  const text='a'.repeat(4095)+'😀suffix';
  expect(estimator.estimate(text)).toBe(4102);
  expect(estimator.estimate(text)).toBe(4102);
  expect(chunks).toEqual(['a'.repeat(4095), '😀suffix']);
  const other = new ChunkTokenEstimator(() => 99);
  expect(other.estimate('😀suffix')).toBe(99);
});
