import {test,expect} from 'bun:test';
import {BoundedCache} from '../src/lib/bounded-cache';
test('archive-derived cache has non-sliding expiration, LRU eviction and a strict byte ceiling',()=>{
 let now=0;const cache=new BoundedCache<string,string>(2,8,10,()=>now);
 cache.set('a','one',4);cache.set('b','two',4);now=9;expect(cache.get('a')).toBe('one');
 now=10;expect(cache.get('a')).toBeUndefined();expect(cache.get('b')).toBeUndefined();
 cache.set('a','one',4);cache.set('b','two',4);expect(cache.get('a')).toBe('one');
 cache.set('c','three',4);expect(cache.get('b')).toBeUndefined();expect(cache.stats()).toEqual({entries:2,bytes:8});
 cache.set('too-large','large',9);expect(cache.get('too-large')).toBeUndefined();
 cache.clear();expect(cache.stats()).toEqual({entries:0,bytes:0});
});
