import {expect,test} from 'bun:test';
import {preflightCanonicalBeforeRetainedRetirement} from '../src/adapters/chatgpt-web/browser-worker';

test('over-budget canonical preparation fails before the last retained tab is retired', async()=>{
  const seen:string[]=[];
  await expect(preflightCanonicalBeforeRetainedRetirement(
    async()=>{seen.push('prepare');throw new Error('context_transport_unsupported: 80893 > 71808');},
    async()=>{seen.push('retire');},
  )).rejects.toThrow('context_transport_unsupported');
  expect(seen).toEqual(['prepare']);
});

test('a prepared but aborted canonical bootstrap does not retire a retained tab', async()=>{
  const seen:string[]=[];
  const controller=new AbortController();
  await expect(preflightCanonicalBeforeRetainedRetirement(
    async()=>{seen.push('prepare'); controller.abort(new Error('cancelled')); return {
      release:()=>{seen.push('prepared-released');},
    };},
    async()=>{seen.push('retire');},
    controller.signal,
  )).rejects.toThrow('cancelled');
  expect(seen).toEqual(['prepare','prepared-released']);
});

test('a successful canonical preflight retires tab after compiling, and returns exact draft for Send', async()=>{
  const seen:string[]=[];
  const drafted = { text:'canonical message', release:()=>{seen.push('prepared-released');} };
  const exact=await preflightCanonicalBeforeRetainedRetirement(
    async()=>{seen.push('prepare');return drafted;},
    async()=>{seen.push('retire');},
  );
  expect(exact).toBe(drafted);
  expect(seen).toEqual(['prepare','retire']);
  exact.release();
  expect(seen).toEqual(['prepare','retire','prepared-released']);
});

test('failed draft cleanup cannot destroy the retained tab',async()=>{
  let retired=false;
  await expect(preflightCanonicalBeforeRetainedRetirement(
    async()=>({release:()=>{throw new Error('draft release failed');}}),
    async()=>{retired=true;},
  )).rejects.toThrow('draft release failed');
  expect(retired).toBe(false);
});
