import {expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {ScreenObservationRegistry,type NativeScreenProvider,type ScreenReaderGrant} from '../src/adapters/chatgpt-web/screen-observation';

type Format='json'|'compact'|'both'|undefined;
function setup(options:{delaySecond?:boolean;identity?:(order:number)=>{frame:number;generation:number}}={}) {
  const readiness={mode:'ui_ready' as const,region:{x:20,y:30,width:20,height:10},contains:'Frame'};
  let grant:ScreenReaderGrant={observer_protocol:1,reader_lease:'reader_'+'b'.repeat(64),
    session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),
    owner_epoch:1,expires_in_ms:30000,region:{x:10,y:20,width:200,height:100},
    observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
  let seq=0,releaseOld=()=>{},oldStarted=()=>{};
  const oldGate=new Promise<void>(resolve=>{releaseOld=resolve;});
  const oldEntered=new Promise<void>(resolve=>{oldStarted=resolve;});
  const provider:NativeScreenProvider={observe:async(g,args)=>{
    const order=++seq,{frame,generation}=options.identity?.(order)??{frame:order+6,generation:4};
    if(order===2&&options.delaySecond!==false){oldStarted();await oldGate;}
    return {observer_protocol:1,operation_id:args.operation_id,session:g.session,hwnd:g.hwnd,pid:g.pid,
      owner_epoch:g.owner_epoch,region:g.region,status:'READY',image_encoded:false,
      image_delivery_status:'UNAVAILABLE',frame_id:frame,target_generation:generation,
      capture:{width:g.region.width,height:g.region.height,frame_id:frame,target_generation:generation,
        backend:'gdi',dpi:96,region:g.region,capture_type:'desktop_region',image_encoded:false,
        capture_pixels_ms:1,raw_copy_ms:0.1,image_encode_ms:0,capture_total_ms:1.1,
        pixel_freshness:'sampled_visible_desktop'},
      readiness:{status:'READY',semantic_ready:true,final_frames:1,mode:'ui_ready',region:readiness.region,
        semantic_frame_id:frame,semantic_generation:generation,predicate:'ocr_text_contains',
        predicate_sha256:createHash('sha256').update(readiness.contains,'utf8').digest('hex')},
      nodes:[{source:'uia',id:'stable',role:'Button',name:`Frame ${frame}`,
        parent_id:null,bounds:{x:10,y:20,width:40,height:20},pixel_correspondence:'unverified'}],
      sources:{cv:{status:'completed',source_count:0,truncated:false},
        uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',
        sample_start_ms:1,sample_end_ms:2},ocr:{status:'completed',confidence_available:false,
          frame_id:frame,target_generation:generation}}};
  }};
  const registry=new ScreenObservationRegistry(provider,()=>1000);
  const binding='binding',owner='owner';
  registry.remember(binding,owner,{content:[],structuredContent:{ok:true,data:grant}});
  const observe=(format:Format,more:Record<string,unknown>={})=>registry.observe(binding,owner,
    {reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:20,readiness,...(format?{tree_format:format}:{}),...more},async()=>{});
  const rotate=()=>{
    grant={...grant,reader_lease:'reader_'+'c'.repeat(64),owner_epoch:2,capability_epoch:randomUUID()};
    registry.remember(binding,owner,{content:[],structuredContent:{ok:true,data:grant}});
  };
  return {observe,oldEntered,releaseOld,rotate};
}

for(const delayedFormat of [undefined,'json','compact','both'] as const){
  test(`an out-of-order ${delayedFormat??'legacy'} result cannot publish an older frame`,async()=>{
    const f=setup();
    const first=await f.observe('json');
    expect((first.tree_update as {frame_id:number}).frame_id).toBe(7);
    const delayed=f.observe(delayedFormat);
    await f.oldEntered;
    const newer=await f.observe('json');
    expect((newer.tree_update as {frame_id:number}).frame_id).toBe(9);
    const latestAck=(newer.tree_update as {snapshot_id:string}).snapshot_id;
    f.releaseOld();
    await expect(delayed).rejects.toThrow('SCREEN_READER_STALE_FRAME');
    const next=await f.observe('json',{ack_snapshot_id:latestAck,prefer_diff:true});
    expect((next.tree_update as {mode:string}).mode).toBe('diff');
    expect((next.tree_update as {base_snapshot_id:string}).base_snapshot_id).toBe(latestAck);
    expect((next.tree_update as {frame_id:number}).frame_id).toBe(10);
  });
}

test('legacy-only observations also reject a delayed older frame without an ACK cache',async()=>{
  const f=setup();
  await f.observe(undefined);
  const delayed=f.observe(undefined);
  await f.oldEntered;
  const newer=await f.observe(undefined);
  expect(newer.frame_id).toBe(9);
  f.releaseOld();
  await expect(delayed).rejects.toThrow('SCREEN_READER_STALE_FRAME');
});

test('legacy reader rejects an obsolete generation even with a higher numeric frame ID',async()=>{
  const f=setup({delaySecond:false,identity:order=>order===1?{generation:6,frame:70}:
    order===2?{generation:7,frame:1}:{generation:6,frame:500}});
  expect((await f.observe(undefined)).target_generation).toBe(6);
  expect((await f.observe(undefined)).target_generation).toBe(7);
  await expect(f.observe(undefined)).rejects.toThrow('SCREEN_READER_STALE_FRAME');
});

test('a fresh delegated grant retires old frame ordering and permits a new target epoch',async()=>{
  const f=setup({delaySecond:false,identity:order=>order===1?{generation:4,frame:70}:{generation:1,frame:1}});
  expect((await f.observe(undefined)).frame_id).toBe(70);
  f.rotate();
  const fresh=await f.observe('json');
  expect((fresh.tree_update as {mode:string}).mode).toBe('full');
  expect((fresh.tree_update as {frame_id:number}).frame_id).toBe(1);
});

test('a delayed old-grant observation cannot retire a new grant ACK chain',async()=>{
  const f=setup();
  const first=await f.observe('json');
  expect((first.tree_update as {frame_id:number}).frame_id).toBe(7);
  const oldPending=f.observe('json');
  await f.oldEntered;
  f.rotate();
  const fresh=await f.observe('json');
  expect((fresh.tree_update as {mode:string}).mode).toBe('full');
  const freshId=(fresh.tree_update as {snapshot_id:string}).snapshot_id;
  f.releaseOld();
  await expect(oldPending).rejects.toThrow('SCREEN_READER_STALE');
  const next=await f.observe('json',{ack_snapshot_id:freshId,prefer_diff:true});
  expect((next.tree_update as {mode:string;base_snapshot_id:string}).mode).toBe('diff');
  expect((next.tree_update as {base_snapshot_id:string}).base_snapshot_id).toBe(freshId);
  expect((next.tree_update as {frame_id:number}).frame_id).toBe(10);
});
