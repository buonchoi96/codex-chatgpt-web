import {expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {ScreenObservationRegistry,type NativeScreenProvider,type ScreenReaderGrant} from '../src/adapters/chatgpt-web/screen-observation';

for(const interruptedFormat of ['json','both'] as const){
  test(`cancelled ${interruptedFormat} observation cannot retire the last delivered snapshot`,async()=>{
    const controller=new AbortController();
    let clockReads=0,cancelOnRead=0,sequence=0;
    const clock=()=>{
      clockReads++;
      if(clockReads===cancelOnRead)controller.abort(new Error('fixture final-publication cancellation'));
      return 1000;
    };
    const grant:ScreenReaderGrant={observer_protocol:1,reader_lease:'reader_'+'a'.repeat(64),
      session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),
      owner_epoch:1,expires_in_ms:30000,region:{x:10,y:20,width:200,height:100},
      observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
    const provider:NativeScreenProvider={observe:async(g,args)=>{
      // A cancelled future frame must not poison the published high-water
      // mark: frame 8 remains valid after a rejected frame 100.
      const id=[7,100,8][sequence++];
      if(id===undefined)throw new Error('fixture returned an unexpected extra observation');
      return {observer_protocol:1,operation_id:args.operation_id,session:g.session,hwnd:g.hwnd,
        pid:g.pid,owner_epoch:g.owner_epoch,region:g.region,status:'READY',image_encoded:false,
        image_delivery_status:'UNAVAILABLE',frame_id:id,target_generation:4,
        capture:{width:g.region.width,height:g.region.height,frame_id:id,target_generation:4,
          backend:'gdi',dpi:96,region:g.region,capture_type:'desktop_region',image_encoded:false,
          capture_pixels_ms:1,raw_copy_ms:0.1,image_encode_ms:0,capture_total_ms:1.1,
          pixel_freshness:'sampled_visible_desktop'},
        readiness:{status:'READY',semantic_ready:true,final_frames:1,mode:'ui_ready',
          region:{x:20,y:30,width:20,height:10},semantic_frame_id:id,semantic_generation:4,predicate:'ocr_text_contains',
          predicate_sha256:createHash('sha256').update('Frame','utf8').digest('hex')},
        nodes:[{source:'uia',id:'stable-control',parent_id:null,role:'Button',name:`Frame ${id}`,
          bounds:{x:20,y:30,width:40,height:20},pixel_correspondence:'unverified'}],
        sources:{cv:{status:'completed',source_count:0,truncated:false},
          uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',
          sample_start_ms:1,sample_end_ms:2},ocr:{status:'completed',confidence_available:false,
            frame_id:id,target_generation:4}}};
    }};
    const registry=new ScreenObservationRegistry(provider,clock);
    const binding='binding',owner='owner';
    registry.remember(binding,owner,{content:[],structuredContent:{ok:true,data:grant}});
    const options={reader_lease:grant.reader_lease,timeout_ms:1000,max_nodes:20,
      readiness:{mode:'ui_ready' as const,region:{x:20,y:30,width:20,height:10},contains:'Frame'}};
    const first=await registry.observe(binding,owner,{...options,tree_format:'json'},async()=>{});
    expect((first.tree_update as {mode:string}).mode).toBe('full');
    const acknowledged=(first.tree_update as {snapshot_id:string}).snapshot_id;

    // prune(), post-provider validation, final publication validation: abort
    // on the last clock read, after projecting a complete valid native frame.
    clockReads=0;
    cancelOnRead=3;
    await expect(registry.observe(binding,owner,{...options,tree_format:interruptedFormat},
      async()=>{},controller.signal)).rejects.toThrow('fixture final-publication cancellation');
    cancelOnRead=0;
    clockReads=0;
    expect(controller.signal.aborted).toBe(true);

    // The caller received frame 7. Cancelled frame 100 must not replace
    // its ACK base, regardless of whether frame 8 used JSON or both format.
    const next=await registry.observe(binding,owner,{...options,tree_format:'json',
      prefer_diff:true,ack_snapshot_id:acknowledged},async()=>{});
    expect((next.tree_update as {mode:string}).mode).toBe('diff');
    expect((next.tree_update as {base_snapshot_id:string}).base_snapshot_id).toBe(acknowledged);
    expect((next.tree_update as {frame_id:number}).frame_id).toBe(8);
    expect((next.tree_diff as {updated:Array<{name:string}>}).updated[0]?.name).toBe('Frame 8');
  });
}
