import {expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createChatGptMcpServer} from '../src/adapters/chatgpt-web/mcp-server';
import type {NativeScreenProvider} from '../src/adapters/chatgpt-web/screen-observation';
import {TurnBroker} from '../src/adapters/chatgpt-web/turn-broker';
import {defaultBrokerEndpoint} from '../src/config';

const grantWire='mcp__fixture__swift_observer_reader_grant';
async function bounded<T>(p:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Screen tree fixture deadline')),5000);})]);}
 finally{if(timer)clearTimeout(timer);}}
async function fixture(run:(f:{client:Client;token:string;lease:string;calls:Record<string,unknown>[];mutate:(value:Record<string,unknown>)=>void;authorize:()=>Promise<void>;revokeAfterDispatch:()=>void})=>Promise<void>){
 const parent=realpathSync(process.platform==='win32'?tmpdir():'/tmp'),root=mkdtempSync(join(parent,'cgw-tree-'));
 const broker=TurnBroker.forSocket(defaultBrokerEndpoint(root));
 const [ct,st]=InMemoryTransport.createLinkedPair(),client=new Client({name:'screen-tree-fixture',version:'1'});
 let server:Awaited<ReturnType<typeof createChatGptMcpServer>>|undefined;
 try{
  const region={x:10,y:20,width:200,height:100};
  const grant={observer_protocol:1,reader_lease:'reader_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),
   session:randomUUID(),hwnd:'481',pid:991,consumer_owner:randomUUID(),capability_epoch:randomUUID(),owner_epoch:1,
   expires_in_ms:30000,region,observer_tree_available:false,image_delivery_status:'UNAVAILABLE'};
  const calls:Record<string,unknown>[]=[],changes:Record<string,unknown>={};let afterDispatch:(()=>void)|undefined;
  const provider:NativeScreenProvider={observe:async(g,args)=>{
   calls.push(structuredClone(args));afterDispatch?.();
   const currentFrame=typeof changes.frame_id==='number'?changes.frame_id:7;
   const currentGeneration=typeof changes.target_generation==='number'?changes.target_generation:4;
   return {observer_protocol:1,operation_id:args.operation_id,session:g.session,hwnd:g.hwnd,pid:g.pid,
    owner_epoch:g.owner_epoch,region:g.region,status:'PARTIAL',image_encoded:false,image_delivery_status:'UNAVAILABLE',frame_id:7,target_generation:4,
    nodes:[{source:'uia',id:'root',parent_id:null,role:'Window',name:'Fixture',bounds:{x:10,y:20,width:200,height:100},pixel_correspondence:'unverified'},
     {source:'uia',id:'button',parent_id:'root',role:'Button',name:'Mở',patterns:['Invoke'],bounds:{x:10,y:20,width:100,height:20},pixel_correspondence:'unverified'},
     {source:'ocr',id:'text',role:'text',name:'Chào 世界',confidence:null,confidence_status:'unavailable',bounds:{x:20,y:50,width:100,height:20},frame_id:7,target_generation:4},
     {source:'cv',id:'cv',role:'visual_region',name:'',confidence:0.8,bounds:{x:120,y:50,width:40,height:30},frame_id:7,target_generation:4}],
    sources:{cv:{status:'completed',source_count:1,truncated:false},uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',sample_start_ms:501,sample_end_ms:509},
     ocr:{status:'completed',confidence_available:false,language:'vi-VN',frame_id:currentFrame,target_generation:currentGeneration}},
    capture:{width:region.width,height:region.height,frame_id:currentFrame,target_generation:currentGeneration,
      backend:'gdi',dpi:96,region,capture_type:'desktop_region',image_encoded:false,
      capture_pixels_ms:1,raw_copy_ms:0.1,image_encode_ms:0,capture_total_ms:1.1,
      pixel_freshness:'sampled_visible_desktop'},
    ...(args.readiness&&changes.status==='READY'?{readiness:{status:'READY',semantic_ready:true,
      final_frames:1,mode:'ui_ready',region:args.readiness.region,semantic_frame_id:currentFrame,
      semantic_generation:currentGeneration,predicate:'ocr_text_contains',
      predicate_sha256:createHash('sha256').update(args.readiness.contains,'utf8').digest('hex')}}:{}),...changes};
  }};
  const token=await broker.register({cwd:root,roots:[root],writableRoots:[],sandboxPolicy:{type:'readOnly',networkAccess:false},
   tools:[{namespace:'mcp__fixture',name:'swift_observer_reader_grant',description:'Synthetic read-only grant fixture',parameters:{}}]},30000,'screen-tree');
  server=await createChatGptMcpServer({brokerSocketPath:broker.socketPath,transport:st,screenObserver:{provider,grantWireName:grantWire}});
  await bounded(client.connect(ct));
  const authorize=async()=>{
   const pending=client.callTool({name:'codex_tool_call',arguments:{turn_token:token,wire_name:grantWire,arguments:{}}});void pending.catch(()=>{});
   const [request]=await bounded(broker.nextToolBatch(token));expect(request?.wireName).toBe(grantWire);
   broker.completeTool(token,request!.callId,{content:[],structuredContent:{ok:true,data:grant}});
   expect((await bounded(pending)).isError).not.toBe(true);
  };
  await run({client,token,lease:grant.reader_lease,calls,mutate:value=>Object.assign(changes,value),authorize,revokeAfterDispatch:()=>{afterDispatch=()=>broker.revoke(token);}});
 }finally{
  const cleanup=await Promise.allSettled([client.close(),server?.close(),broker.close()]);
  const canonical=realpathSync(root);
  if(canonical!==resolve(root)||dirname(canonical)!==parent||!basename(canonical).startsWith('cgw-tree-'))throw Error('Refusing non-owned tree fixture cleanup');
  rmSync(canonical,{recursive:true,force:true});
  const failed=cleanup.find(x=>x.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
 }
}
const call=(client:Client,token:string,lease:string,format?:string,extra:Record<string,unknown>={})=>bounded(client.callTool({name:'codex_screen_observe',
 arguments:{turn_token:token,reader_lease:lease,...(format?{tree_format:format}:{}),...extra}},undefined,{timeout:5000,maxTotalTimeout:5000}));
const readyParams={readiness:{mode:'ui_ready' as const,region:{x:20,y:40,width:35,height:25},contains:'Fixture'}};
const readyCall=(client:Client,token:string,lease:string,format?:string,extra:Record<string,unknown>={})=>
 call(client,token,lease,format,{...extra,...readyParams});

test('omitted format preserves legacy observer payload and native arguments',async()=>{
 await fixture(async f=>{await f.authorize();const r=await call(f.client,f.token,f.lease);
  expect(r.isError).not.toBe(true);expect(r.structuredContent).toHaveProperty('nodes');
  expect(r.structuredContent).not.toHaveProperty('tree');expect(f.calls).toHaveLength(1);expect(f.calls[0]).not.toHaveProperty('tree_format');
 });
});
test('MCP both format exposes a bounded source-aware tree after an authenticated grant',async()=>{
 await fixture(async f=>{await f.authorize();const listed=await bounded(f.client.listTools());
  expect(listed.tools.find(t=>t.name==='codex_screen_observe')?.inputSchema.properties).toHaveProperty('tree_format');
  const r=await call(f.client,f.token,f.lease,'both');expect(r.isError).not.toBe(true);
  const body=r.structuredContent as Record<string,any>;expect(body.tree).toBeDefined();
  expect(body).not.toHaveProperty('nodes');
  expect(body.tree.frame_id).toBe(7);expect(body.tree.target_generation).toBe(4);expect(body.tree.coordinate_space).toBe('authorized_viewport');
  expect(body.tree.nodes).toHaveLength(4);expect(body.tree.compact).toContain('Chào 世界');
  for(const n of body.tree.nodes)expect(body.tree.compact).toContain(n.ephemeral_id);
  expect(Buffer.byteLength(JSON.stringify(body.tree),'utf8')).toBeLessThanOrEqual(16384);
  expect(body.image_delivery_status).toBe('UNAVAILABLE');expect(body.image_encoded).toBe(false);
  expect(body.status).toBe('PARTIAL');expect(JSON.stringify(body.tree)).toContain('after_final_frame');expect(JSON.stringify(body.tree)).toContain('unverified');
  expect(f.calls).toHaveLength(1);expect(f.calls[0]).not.toHaveProperty('tree_format');
 });
});

test('rejects capture metadata from an unrelated frame before publishing a tree',async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({capture:{
  width:200,height:100,frame_id:8,target_generation:4,backend:'gdi',dpi:96,
  region:{x:10,y:20,width:200,height:100},capture_type:'desktop_region',image_encoded:false,
  capture_pixels_ms:1,raw_copy_ms:0.5,image_encode_ms:0,capture_total_ms:1.5,
  pixel_freshness:'sampled_visible_desktop',
 }});
  const result=await call(f.client,f.token,f.lease,'both');
  expect(result.isError).toBe(true);
  expect(result.structuredContent).not.toHaveProperty('tree');
  expect(f.calls).toHaveLength(1);
 });
});

test('accepts capture metadata matching the published frame and authorized viewport',async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({capture:{
  width:200,height:100,frame_id:7,target_generation:4,backend:'gdi',dpi:96,
  region:{x:10,y:20,width:200,height:100},capture_type:'desktop_region',image_encoded:false,
  capture_pixels_ms:1,raw_copy_ms:0.5,image_encode_ms:0,capture_total_ms:1.5,
  pixel_freshness:'sampled_visible_desktop',
 }});
  const result=await call(f.client,f.token,f.lease,'both');
  expect(result.isError).not.toBe(true);
  expect((result.structuredContent as Record<string,any>).tree.frame_id).toBe(7);
  expect(f.calls).toHaveLength(1);
 });
});

test('rejects OCR source receipt whose frame differs from the published frame',async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({sources:{
  cv:{status:'completed',source_count:1,truncated:false},
  uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',
    pixel_correspondence:'unverified',sample_start_ms:501,sample_end_ms:509},
  ocr:{status:'completed',confidence_available:false,language:'vi-VN',frame_id:8,target_generation:4},
 }});
  const result=await call(f.client,f.token,f.lease,'both');
  expect(result.isError).toBe(true);
  expect(result.structuredContent).not.toHaveProperty('tree');
  expect(f.calls).toHaveLength(1);
 });
});

test('rejects READY without a final-frame semantic readiness proof',async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({status:'READY',
  readiness:{status:'READY',semantic_ready:true,final_frames:1}});
  const observed=await call(f.client,f.token,f.lease,'json');
  expect(observed.isError).toBe(true);
  expect(observed.structuredContent).not.toHaveProperty('tree');
  expect(f.calls).toHaveLength(1);
 });
});

test('rejects READY when semantic readiness reports a different completion status',async()=>{
 await fixture(async f=>{await f.authorize();const region={x:20,y:40,width:35,height:25};
  f.mutate({status:'READY',readiness:{status:'NOT_READY',semantic_ready:true,final_frames:1,
    mode:'ui_ready',region,semantic_frame_id:7,semantic_generation:4,predicate:'ocr_text_contains'}});
  const observed=await call(f.client,f.token,f.lease,'json',{
    readiness:{mode:'ui_ready',region,contains:'Continue'}});
  expect(observed.isError).toBe(true);
  expect(observed.structuredContent).not.toHaveProperty('tree');
  expect(f.calls).toHaveLength(1);
 });
});

test('rejects final-frame READY when completed OCR or analysis evidence contradicts it',async()=>{
 for(const failure of ['ocr_unavailable','ocr_wrong_frame','analysis_deadline'] as const){
  await fixture(async f=>{
   await f.authorize();
   const region={x:20,y:40,width:35,height:25};
   f.mutate({status:'READY',readiness:{status:'READY',semantic_ready:true,final_frames:1,
     mode:'ui_ready',region,semantic_frame_id:7,semantic_generation:4,predicate:'ocr_text_contains'},
    ...(failure==='analysis_deadline'?{reason:'observation_deadline'}:{}),
    sources:{cv:{status:failure==='analysis_deadline'?'deadline':'completed',source_count:1,truncated:false},
      uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',
       sample_start_ms:501,sample_end_ms:509},
      ocr:failure==='ocr_unavailable'?{status:'UNAVAILABLE',reason:'native_ocr_not_completed',confidence_available:false}:
       {status:'completed',confidence_available:false,frame_id:failure==='ocr_wrong_frame'?6:7,target_generation:4}}});
   const observed=await call(f.client,f.token,f.lease,'json',{
     readiness:{mode:'ui_ready',region,contains:'Fixture'}});
   expect(observed.isError).toBe(true);
   expect(observed.structuredContent).not.toHaveProperty('tree');
   expect(f.calls).toHaveLength(1);
  });
 }
});

test('rejects NOT_READY claiming a successful semantic sample',async()=>{
 await fixture(async f=>{await f.authorize();const region={x:20,y:40,width:35,height:25};
  f.mutate({status:'NOT_READY',readiness:{status:'NOT_READY',semantic_ready:true,final_frames:1,
    mode:'ui_ready',region,semantic_frame_id:7,semantic_generation:4,predicate:'ocr_text_contains'}});
  const observed=await call(f.client,f.token,f.lease,'json',{
    readiness:{mode:'ui_ready',region,contains:'Continue'}});
  expect(observed.isError).toBe(true);
  expect(observed.structuredContent).not.toHaveProperty('tree');
  expect(f.calls).toHaveLength(1);
 });
});

test('preserves truthful NOT_READY with a failed semantic predicate',async()=>{
 await fixture(async f=>{await f.authorize();const region={x:20,y:40,width:35,height:25};
  f.mutate({status:'NOT_READY',readiness:{status:'NOT_READY',semantic_ready:false,final_frames:1,
    mode:'ui_ready',region,predicate_sha256:createHash('sha256').update('Continue','utf8').digest('hex')}});
  const observed=await call(f.client,f.token,f.lease,'json',{
    readiness:{mode:'ui_ready',region,contains:'Continue'}});
  expect(observed.isError).not.toBe(true);
  expect((observed.structuredContent as Record<string,any>).status).toBe('NOT_READY');
  expect(f.calls).toHaveLength(1);
 });
});
for(const format of ['json','compact'] as const){test('MCP '+format+' format retains only its requested representation',async()=>{
 await fixture(async f=>{await f.authorize();const r=await call(f.client,f.token,f.lease,format);expect(r.isError).not.toBe(true);
  const tree=(r.structuredContent as Record<string,any>).tree;expect(tree).toBeDefined();
  expect(r.structuredContent).not.toHaveProperty('nodes');
  if(format==='json'){expect(tree.nodes).toHaveLength(4);expect(tree).not.toHaveProperty('compact');}
  else{expect(tree.compact).toContain('Chào 世界');expect(tree).not.toHaveProperty('nodes');}
  expect(f.calls).toHaveLength(1);
 });
});}
test('a revoked turn cannot publish formatted output after provider dispatch',async()=>{
 await fixture(async f=>{await f.authorize();f.revokeAfterDispatch();const r=await call(f.client,f.token,f.lease,'both');
  expect(r.isError).toBe(true);expect(r.structuredContent).not.toHaveProperty('tree');expect(f.calls).toHaveLength(1);
 });
});
test('MCP projection does not reveal a redacted UIA parent ID through its child',async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({nodes:[
  {source:'uia',id:'sensitive-parent-provider',parent_id:null,role:'Pane',name:'[REDACTED]',redacted:true,bounds:{x:10,y:20,width:200,height:100},pixel_correspondence:'unverified'},
  {source:'uia',id:'visible-child',parent_id:'sensitive-parent-provider',role:'Button',name:'Next',bounds:{x:20,y:30,width:20,height:10},pixel_correspondence:'unverified'},
 ]});const r=await call(f.client,f.token,f.lease,'both');expect(r.isError).not.toBe(true);
  const body=r.structuredContent as Record<string,any>;
  expect(body.tree.nodes).toHaveLength(2);expect(body.tree.nodes[1].parent.status).toBe('linked');
  expect(JSON.stringify(body.tree)).not.toContain('sensitive-parent-provider');
  // Opt-in tree mode must not duplicate the raw provider receipt, whose parent
  // IDs may identify an intentionally redacted UIA ancestor.
  expect(body).not.toHaveProperty('nodes');
  expect(JSON.stringify(body)).not.toContain('sensitive-parent-provider');
 });
});

test('UIA-only incremental response requires explicit acknowledgement of the latest published snapshot',async()=>{
 await fixture(async f=>{
  await f.authorize();
  const node=(id:string,x:number,name:string)=>({source:'uia',id,role:'Button',name,
    bounds:{x,y:20,width:20,height:10},pixel_correspondence:'unverified'});
   f.mutate({status:'READY',
    nodes:[node('stable',20,'Old'),node('removed',50,'Gone')]});
   const first=await readyCall(f.client,f.token,f.lease,'json',{prefer_diff:true});
  expect(first.isError).not.toBe(true);
  const firstBody=first.structuredContent as Record<string,any>;
  expect(firstBody.tree_update.mode).toBe('full');
  const ack=firstBody.tree_update.snapshot_id;
  expect(ack).toMatch(/^[0-9a-f-]{36}$/);

  f.mutate({frame_id:8,nodes:[node('stable',25,'New'),node('added',60,'Hello')]});
   const second=await readyCall(f.client,f.token,f.lease,'json',{prefer_diff:true,ack_snapshot_id:ack});
  expect(second.isError).not.toBe(true);
  const changed=second.structuredContent as Record<string,any>;
  expect(changed.tree_update).toMatchObject({mode:'diff',base_snapshot_id:ack,frame_id:8,target_generation:4});
  expect(changed).not.toHaveProperty('tree');
  expect(changed.tree_diff.added.map((n:any)=>n.provider_id)).toEqual(['added']);
  expect(changed.tree_diff.updated.map((n:any)=>n.provider_id)).toEqual(['stable']);
  expect(changed.tree_diff.removed).toEqual(['removed']);

  f.mutate({frame_id:9});
   const stale=await readyCall(f.client,f.token,f.lease,'json',{prefer_diff:true,ack_snapshot_id:ack});
  expect((stale.structuredContent as Record<string,any>).tree_update.mode).toBe('full');
  await f.authorize(); // A fresh grant invalidates any previous snapshot ownership.
  f.mutate({frame_id:10});
   const rotated=await readyCall(f.client,f.token,f.lease,'json',{prefer_diff:true,
    ack_snapshot_id:(stale.structuredContent as Record<string,any>).tree_update.snapshot_id});
  expect((rotated.structuredContent as Record<string,any>).tree_update.mode).toBe('full');
  expect(f.calls).toHaveLength(4);
 });
});

test('UIA-only delta exceeding 16 KiB falls back to an intact bounded full snapshot',async()=>{
 await fixture(async f=>{
  await f.authorize();
  const nodes=(prefix:string)=>Array.from({length:40},(_,i)=>({
   source:'uia',id:prefix+String(i).padStart(3,'0')+'X'.repeat(105),name:'Node'+i,
   bounds:{x:10+(i%10)*10,y:20,width:5,height:5},pixel_correspondence:'unverified'
  }));
   f.mutate({status:'READY',nodes:nodes('A')});
   const first=await readyCall(f.client,f.token,f.lease,'json',{prefer_diff:true});
  expect(first.isError).not.toBe(true);
  const before=first.structuredContent as Record<string,any>;
  expect(before.tree_update.mode).toBe('full');
  expect(before.tree.truncated).toBe(false);
  expect(before.tree.nodes).toHaveLength(40);
  f.mutate({frame_id:8,nodes:nodes('B')});
   const second=await readyCall(f.client,f.token,f.lease,'json',{
   prefer_diff:true,ack_snapshot_id:before.tree_update.snapshot_id});
  expect(second.isError).not.toBe(true);
  const after=second.structuredContent as Record<string,any>;
  expect(after.tree_update.mode).toBe('full');
  expect(after).not.toHaveProperty('tree_diff');
  expect(after.tree.truncated).toBe(false);
  expect(after.tree.nodes).toHaveLength(40);
  expect(Buffer.byteLength(JSON.stringify(after.tree),'utf8')).toBeLessThanOrEqual(16384);
  expect(f.calls).toHaveLength(2);
 });
});

test('mixed OCR/CV frames fall back to full snapshots despite valid explicit ACK',async()=>{
 await fixture(async f=>{
  await f.authorize();
  const first=await call(f.client,f.token,f.lease,'json');
  const ack=(first.structuredContent as Record<string,any>).tree_update.snapshot_id;
  f.mutate({frame_id:8,nodes:[{source:'ocr',id:'text',role:'text',name:'New frame',
    bounds:{x:20,y:50,width:60,height:20},frame_id:8,target_generation:4,
    confidence:null,confidence_status:'unavailable'}]});
  const second=await call(f.client,f.token,f.lease,'json',{prefer_diff:true,ack_snapshot_id:ack});
  expect(second.isError).not.toBe(true);
  expect((second.structuredContent as Record<string,any>).tree_update.mode).toBe('full');
  expect((second.structuredContent as Record<string,any>).tree.nodes).toHaveLength(1);
  expect(f.calls).toHaveLength(2);
 });
});

test('explicit mixed-diff ACK replaces volatile OCR/CV and patches only stable UIA identities',async()=>{
 await fixture(async f=>{
  await f.authorize();
   f.mutate({status:'READY'});
   const first=await readyCall(f.client,f.token,f.lease,'json',{prefer_mixed_diff:true});
  expect(first.isError).not.toBe(true);
  const before=first.structuredContent as Record<string,any>;
  expect(before.tree_update.mode).toBe('full');
  const changedNodes=[
   {source:'uia',id:'root',parent_id:null,role:'Window',name:'Fixture',
    bounds:{x:10,y:20,width:200,height:100},pixel_correspondence:'unverified'},
   {source:'uia',id:'button',parent_id:'root',role:'Button',name:'Updated control',
    bounds:{x:10,y:20,width:100,height:20},pixel_correspondence:'unverified',
    is_enabled:false,is_offscreen:false,is_focused:true},
   {source:'ocr',id:'text-new',role:'text',name:'Tạm biệt 世界',confidence:null,
    confidence_status:'unavailable',bounds:{x:20,y:50,width:100,height:20},frame_id:8,target_generation:4},
   {source:'cv',id:'cv-new',role:'visual_region',name:'',confidence:0.9,
    bounds:{x:130,y:50,width:40,height:30},frame_id:8,target_generation:4}
  ];
  f.mutate({frame_id:8,nodes:changedNodes,
   sources:{cv:{status:'completed',source_count:1,truncated:false},
    uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',
      sample_start_ms:501,sample_end_ms:509},
    ocr:{status:'completed',confidence_available:false,language:'vi-VN',frame_id:8,target_generation:4}}});
   const second=await readyCall(f.client,f.token,f.lease,'json',{
   prefer_mixed_diff:true,ack_snapshot_id:before.tree_update.snapshot_id});
  expect(second.isError).not.toBe(true);
  const body=second.structuredContent as Record<string,any>;
  expect(body.tree_update.mode).toBe('mixed_diff');
  expect(body).not.toHaveProperty('tree');
  expect(body).not.toHaveProperty('nodes');
  expect(body.tree_diff.identity).toBe('uia_provider_within_authorized_lease');
  expect(body.tree_diff.updated.map((n:any)=>n.provider_id)).toEqual(['button']);
  expect(body.tree_diff.updated[0]).toMatchObject({is_enabled:false,is_offscreen:false,is_focused:true});
  expect(body.tree_diff.transient_mode).toBe('replace_all_for_current_frame');
  expect(body.tree_diff.transient_nodes.map((n:any)=>n.source).sort()).toEqual(['cv','ocr']);
  expect(body.tree_diff.transient_nodes.find((n:any)=>n.source==='ocr').name).toBe('Tạm biệt 世界');
  expect(body.tree_diff.transient_nodes.some((n:any)=>'provider_id' in n)).toBe(false);
  expect(body.tree_diff.source_counts.returned).toEqual({cv:1,ocr:1,uia:2});
  const nextNodes=changedNodes.map(node=>node.source==='ocr'||node.source==='cv'
   ?{...node,frame_id:9}:node);
  f.mutate({frame_id:9,nodes:nextNodes,sources:{cv:{status:'completed',source_count:1,truncated:false},
    uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',
     sample_start_ms:602,sample_end_ms:609},
    ocr:{status:'completed',confidence_available:false,language:'vi-VN',frame_id:9,target_generation:4}}});
   const chained=await readyCall(f.client,f.token,f.lease,'json',{
   prefer_mixed_diff:true,ack_snapshot_id:body.tree_update.snapshot_id});
  expect(chained.isError).not.toBe(true);
  const chainedBody=chained.structuredContent as Record<string,any>;
  expect(chainedBody.tree_update.mode).toBe('mixed_diff');
  expect(chainedBody.tree_update.base_snapshot_id).toBe(body.tree_update.snapshot_id);
  expect(chainedBody.tree_diff.updated).toEqual([]);
  expect(chainedBody.tree_diff.transient_nodes).toHaveLength(2);
   const oldAck=await readyCall(f.client,f.token,f.lease,'json',{
   prefer_mixed_diff:true,ack_snapshot_id:before.tree_update.snapshot_id});
  expect(oldAck.isError).not.toBe(true);
  expect((oldAck.structuredContent as Record<string,any>).tree_update.mode).toBe('full');
 });
});

test('MCP acknowledgement invalidates incremental UIA diffs on DPI and capture backend changes',async()=>{
 await fixture(async f=>{
  await f.authorize();
  const region={x:10,y:20,width:200,height:100};
  const node={source:'uia',id:'stable-button',parent_id:null,role:'Button',name:'Continue',
    bounds:{x:20,y:30,width:90,height:20},pixel_correspondence:'unverified'};
  const setFrame=(frame_id:number,dpi:number,backend:'gdi'|'dxgi')=>f.mutate({
    status:'READY',frame_id,nodes:[node],
    sources:{cv:{status:'completed',source_count:0,truncated:false},
      uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',
        sample_start_ms:1,sample_end_ms:2},
      ocr:{status:'completed',confidence_available:false,frame_id,target_generation:4}},
    capture:{width:200,height:100,frame_id,target_generation:4,backend,dpi,region,
      capture_type:'desktop_region',image_encoded:false,capture_pixels_ms:1,raw_copy_ms:0.1,
      image_encode_ms:0,capture_total_ms:1.1,pixel_freshness:'sampled_visible_desktop'}});
  setFrame(7,96,'gdi');
  const first=await readyCall(f.client,f.token,f.lease,'json');
  expect(first.isError).not.toBe(true);
  const a=first.structuredContent as Record<string,any>;
  expect(a.tree_update.mode).toBe('full');
  setFrame(8,120,'gdi');
  const changedDpi=await readyCall(f.client,f.token,f.lease,'json',{
    prefer_diff:true,ack_snapshot_id:a.tree_update.snapshot_id});
  expect(changedDpi.isError).not.toBe(true);
  const b=changedDpi.structuredContent as Record<string,any>;
  expect(b.tree_update.mode).toBe('full');
  setFrame(9,120,'gdi');
  const sameScope=await readyCall(f.client,f.token,f.lease,'json',{
    prefer_diff:true,ack_snapshot_id:b.tree_update.snapshot_id});
  expect(sameScope.isError).not.toBe(true);
  const c=sameScope.structuredContent as Record<string,any>;
  expect(c.tree_update.mode).toBe('diff');
  setFrame(10,120,'dxgi');
  const changedBackend=await readyCall(f.client,f.token,f.lease,'json',{
    prefer_diff:true,ack_snapshot_id:c.tree_update.snapshot_id});
  expect(changedBackend.isError).not.toBe(true);
  expect((changedBackend.structuredContent as Record<string,any>).tree_update.mode).toBe('full');
  expect(f.calls).toHaveLength(4);
 });
});

test('MCP cannot deduplicate an ACK when neither frame has a verified capture descriptor',async()=>{
 await fixture(async f=>{
  await f.authorize();
  const setFrame=(frame_id:number)=>f.mutate({
    status:'READY',frame_id,capture:undefined,
    nodes:[{source:'uia',id:'control',parent_id:null,name:'OK',role:'Button',
      bounds:{x:20,y:30,width:80,height:20},pixel_correspondence:'unverified'}],
    sources:{cv:{status:'completed',source_count:0,truncated:false},
      uia:{status:'ok',partial:false,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',sample_start_ms:1,sample_end_ms:2},
      ocr:{status:'completed',confidence_available:false,frame_id,target_generation:4}}});
  setFrame(7);
  const first=await readyCall(f.client,f.token,f.lease,'json');
  expect(first.isError).not.toBe(true);
  const ack=(first.structuredContent as Record<string,any>).tree_update.snapshot_id;
  setFrame(8);
  const next=await readyCall(f.client,f.token,f.lease,'json',{prefer_diff:true,ack_snapshot_id:ack});
  expect(next.isError).not.toBe(true);
  expect((next.structuredContent as Record<string,any>).tree_update.mode).toBe('full');
  expect(f.calls).toHaveLength(2);
 });
});

test('MCP ACK never treats native traversal fallback IDs as provider-stable diff identities',async()=>{
 await fixture(async f=>{
  await f.authorize();
  const nativeNode=(id:string,name:string)=>({source:'uia',id,role:'Button',name,
   bounds:{x:10,y:20,width:50,height:20},pixel_correspondence:'unverified'});
   f.mutate({status:'READY',
    nodes:[nativeNode('fallback.0','first control')]});
   const first=await readyCall(f.client,f.token,f.lease,'json',{prefer_diff:true});
  expect(first.isError).not.toBe(true);
  const ack=(first.structuredContent as Record<string,any>).tree_update.snapshot_id;
  f.mutate({frame_id:8,nodes:[nativeNode('fallback.0','unrelated control')]});
   const second=await readyCall(f.client,f.token,f.lease,'json',{prefer_diff:true,ack_snapshot_id:ack});
  expect(second.isError).not.toBe(true);
  const body=second.structuredContent as Record<string,any>;
  expect(body.tree_update.mode).toBe('full');
  expect(body.tree.nodes[0].name).toBe('unrelated control');
  expect(body).not.toHaveProperty('tree_diff');
  expect(f.calls).toHaveLength(2);
 });
});
test('an older frame cannot replace an already issued JSON snapshot',async()=>{
 await fixture(async f=>{
  await f.authorize();
  const first=await call(f.client,f.token,f.lease,'json');expect(first.isError).not.toBe(true);
  f.mutate({frame_id:6,nodes:[{source:'uia',id:'root',role:'Window',name:'Earlier',
    parent_id:null,bounds:{x:10,y:20,width:200,height:100},pixel_correspondence:'unverified'}]});
  const obsolete=await call(f.client,f.token,f.lease,'json');
  expect(obsolete.isError).toBe(true);
  expect(JSON.stringify(obsolete.structuredContent??obsolete.content)).toContain('SCREEN_READER_STALE_FRAME');
  // A late read-only frame must not retire this turn's still-valid native grant.
  f.mutate({frame_id:8,nodes:[{source:'uia',id:'root',role:'Window',name:'Fresh',
    parent_id:null,bounds:{x:10,y:20,width:200,height:100},pixel_correspondence:'unverified'}]});
  const resumed=await call(f.client,f.token,f.lease,'json');
  expect(resumed.isError).not.toBe(true);
  expect((resumed.structuredContent as Record<string,any>).tree_update.frame_id).toBe(8);
  expect(f.calls).toHaveLength(3);
 });
});
test('source partial/truncation remains explicit when the projection itself fits',async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({
  nodes:[{source:'cv',id:'partial-cv',role:'visual_region',name:'',bounds:{x:10,y:20,width:20,height:10},frame_id:7,target_generation:4}],sources:{
  cv:{status:'completed',source_count:40,truncated:true},
  uia:{status:'timeout',partial:true,temporal_relation:'after_final_frame',pixel_correspondence:'unverified',sample_start_ms:1,sample_end_ms:3},
  ocr:{status:'UNAVAILABLE',reason:'fixture_unavailable',confidence_available:false},
 }});const r=await call(f.client,f.token,f.lease,'both');expect(r.isError).not.toBe(true);
  const body=r.structuredContent as Record<string,any>;expect(body.status).toBe('PARTIAL');
  expect(body.tree.truncated).toBe(false);expect(body.tree.absence_is_proven).toBe(false);
  expect(body.tree.sources.cv.truncated).toBe(true);expect(body.tree.sources.uia.partial).toBe(true);
  expect(body.tree.sources.ocr.status).toBe('UNAVAILABLE');
 });
});
test('invalid tree format is rejected before provider dispatch',async()=>{
 await fixture(async f=>{await f.authorize();const r=await call(f.client,f.token,f.lease,'xml');
  expect(r.isError).toBe(true);expect(f.calls).toHaveLength(0);
 });
});
test('invalid readiness ROI does not dispatch or retire the MCP observer turn',async()=>{
 await fixture(async f=>{
  await f.authorize();
  for(const region of [{x:195,y:40,width:30,height:20},{x:10,y:20,width:200,height:100}]) {
   const denied=await call(f.client,f.token,f.lease,'both',{
    readiness:{mode:'ui_ready',region,contains:'Fixture'}});
   expect(denied.isError).toBe(true);
   expect(JSON.stringify(denied.structuredContent??denied.content)).toContain('SCREEN_READER_READINESS_ROI_INVALID');
   expect(f.calls).toHaveLength(0);
  }
  const subsequent=await call(f.client,f.token,f.lease,'both');
  expect(subsequent.isError).not.toBe(true);
  expect((subsequent.structuredContent as Record<string,any>).tree.frame_id).toBe(7);
  expect(f.calls).toHaveLength(1);
 });
});
test('formatting does not authorize a guessed lease',async()=>{
 await fixture(async f=>{const r=await call(f.client,f.token,'reader_'+'0'.repeat(64),'both');
  expect(r.isError).toBe(true);expect(JSON.stringify(r.content)).toContain('SCREEN_READER_NOT_AUTHORIZED');expect(f.calls).toHaveLength(0);
 });
});
for(const [label,node] of [
 ['outside viewport',{source:'cv',name:'',bounds:{x:0,y:0,width:1,height:1},frame_id:7,target_generation:4}],
 ['wrong frame',{source:'ocr',name:'stale',confidence:null,confidence_status:'unavailable',bounds:{x:10,y:20,width:1,height:1},frame_id:6,target_generation:4}],
] as const){test('tree cannot publish native nodes '+label,async()=>{
 await fixture(async f=>{await f.authorize();f.mutate({nodes:[node]});const r=await call(f.client,f.token,f.lease,'both');
  expect(r.isError).toBe(true);expect(JSON.stringify(r.content)).toContain('SCREEN_OBSERVATION_PROTOCOL');
  expect(r.structuredContent).not.toHaveProperty('tree');expect(f.calls).toHaveLength(1);
 });
});}
