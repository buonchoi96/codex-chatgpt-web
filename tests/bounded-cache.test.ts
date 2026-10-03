import { expect, test } from 'bun:test';
import { BoundedCache } from '../src/lib/bounded-cache';

test('bounded cache evicts least recently used entries and accounts for replacement weight', () => {
  const cache = new BoundedCache<string, string>(2, 6, 1000);
  cache.set('a','one',3); cache.set('b','two',3);
  expect(cache.get('a')).toBe('one');
  cache.set('c','six',3);
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')).toBe('one');
  cache.set('a','long',4);
  expect(cache.get('c')).toBeUndefined();
  expect(cache.get('a')).toBe('long');
});

test('bounded cache expires from insertion even when accessed frequently', () => {
  let now=0; const cache = new BoundedCache<string, number>(2, 8, 10, ()=>now);
  cache.set('a',42,4); now=9; expect(cache.get('a')).toBe(42);
  now=10; expect(cache.get('a')).toBeUndefined();
});

test('oversized replacements cannot leave an old cached value available', () => {
  const cache = new BoundedCache<string, string>(2, 8, 1000);
  cache.set('a','old',3); cache.set('a','too large',9);
  expect(cache.get('a')).toBeUndefined();
});
