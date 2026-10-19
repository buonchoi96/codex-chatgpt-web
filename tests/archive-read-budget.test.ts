import {expect,test} from 'bun:test';
import {waitForArchiveReadBounded} from '../src/adapters/chatgpt-web/archive-read-budget';

test('in-turn archive ingestion gets one awake budget and never expires simply because the OS resumed its timer',async()=>{
  let awake=0,fire=()=>{},finished=false,signal:AbortSignal|undefined;
  const pending=waitForArchiveReadBounded(async received=>{signal=received;await new Promise<void>(()=>{});},undefined,
    ()=>awake,(callback)=>{fire=callback;return()=>{};}).catch(error=>{finished=true;return error;});
  fire();await Bun.sleep(0);expect(signal!.aborted).toBe(false);expect(finished).toBe(false);
  awake=179999;fire();await Bun.sleep(0);expect(signal!.aborted).toBe(false);
  awake=180000;fire();expect(await pending).toMatchObject({code:'context_archive_ingestion_timeout',retryable:false});
});

test('positive archive proof clears the deadline and explicit cancellation immediately ends the read wait',async()=>{
  let cleared=0;
  await waitForArchiveReadBounded(async()=>{},undefined,()=>0,()=>()=>{cleared++;});
  expect(cleared).toBe(1);
  const abort=new AbortController();
  const waiting=waitForArchiveReadBounded(async signal=>await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),abort.signal);
  abort.abort(new DOMException('Fixture user cancelled','AbortError'));
  await expect(waiting).rejects.toMatchObject({name:'AbortError'});
});
