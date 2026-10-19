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

test('refused tab retirement releases the prepared draft without starting Web Send',async()=>{
  let released=false;
  await expect(preflightCanonicalBeforeRetainedRetirement(
    async()=>({release:()=>{released=true;}}),
    async()=>{throw new Error('launcher refused retirement');},
  )).rejects.toThrow('launcher refused retirement');
  expect(released).toBe(true);
});

test('helper preflight requests prepared_selected before waiting for its daemon ACK', async()=>{
  const steps:string[]=[];
  let resolveAck!: (value:{release:()=>void})=>void;
  const ack=new Promise<{release:()=>void}>(resolve=>{resolveAck=resolve;});
  const draft={release:()=>steps.push('released')};
  const prepared=await preflightCanonicalBeforeRetainedRetirement(
    async()=>{steps.push('prepare-await');return ack;},
    async()=>{steps.push('retire');},
    undefined,
    async()=>{steps.push('prepared_selected');resolveAck(draft);},
  );
  expect(prepared).toBe(draft);
  expect(steps).toEqual(['prepared_selected','prepare-await','retire']);
  prepared.release();
  expect(steps.at(-1)).toBe('released');
});

test('failed helper prompt selection never prepares or retires the retained conversation', async()=>{
  const steps:string[]=[];
  await expect(preflightCanonicalBeforeRetainedRetirement(
    async()=>{steps.push('prepare');return {release(){}};},
    async()=>{steps.push('retire');},
    undefined,
    async()=>{steps.push('prepared_selected');throw new Error('daemon preparation rejected');},
  )).rejects.toThrow('daemon preparation rejected');
  expect(steps).toEqual(['prepared_selected']);
});

test('aborted prompt selection is rejected before old retained tabs can be retired', async()=>{
  const controller=new AbortController();
  const steps:string[]=[];
  await expect(preflightCanonicalBeforeRetainedRetirement(
    async()=>{steps.push('prepare');return {release(){}};},
    async()=>{steps.push('retire');},
    controller.signal,
    async()=>{steps.push('prepared_selected');controller.abort(new Error('operator cancelled'));},
  )).rejects.toThrow('operator cancelled');
  expect(steps).toEqual(['prepared_selected']);
});
